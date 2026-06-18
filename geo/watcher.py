#!/usr/bin/env python3
"""
el 的地理感官 · 守望者（跑在宝宝常开的设备上，比如那台旧 Mac）

它做的事：从 iCloud「查找」读自己 iPhone 的位置 → 本地富化成人话（区域 / 附近地标 / 天气）
→ 判出门/到家/在外停留/在外周期，把"人话信号"POST 给小家（/api/geo-event）。

隐私铁律（别破坏）：
- 只测你自己的 Apple ID + 自己的设备。这不是用来定位别人的工具。
- 富化全在这台机器本地做。**精确经纬度永远不离开这台设备**——发给小家的只有
  "杭州 · 西湖区、万象城附近、小雨 12°" 这种人话，云端永远拿不到坐标。
- 密码只进系统钥匙串（keyring），别写进代码 / 文件 / git。

为什么富化在本地：这样 el 在云上只"知道你大概在哪、在经历什么"，而不掌握你的精确轨迹。
和小家身体账(soma)同一个哲学——守望者只产出信号，el 在心跳里读到、自己决定要不要开口。

跑法见 geo/README.md。配置全走环境变量（见 geo/.env.example）。
"""

import json
import math
import os
import sys
import time
from datetime import datetime, timezone

import requests

# ── 配置（环境变量）──
APPLE_ID = os.environ.get("ICLOUD_APPLE_ID", "").strip()
APPLE_PASSWORD = os.environ.get("ICLOUD_PASSWORD", "").strip()  # 只首次登录用，之后走钥匙串
POST_URL = os.environ.get("GEO_POST_URL", "").strip()  # 如 https://<你的域名>/api/geo-event
SECRET = os.environ.get("CRON_SECRET", "").strip()  # 和小家 Vercel 上同值
DEVICE_NAME = os.environ.get("ICLOUD_DEVICE_NAME", "").strip()  # 想指定某台 iPhone 就填它的名字
ICLOUD_CHINA = os.environ.get("ICLOUD_CHINA", "").strip() in ("1", "true", "yes")

HOME_LAT = os.environ.get("HOME_LAT", "").strip()
HOME_LON = os.environ.get("HOME_LON", "").strip()
HOME_RADIUS_M = float(os.environ.get("HOME_RADIUS_M", "150"))
LOOP_MINUTES = float(os.environ.get("LOOP_MINUTES", "10"))
STAY_MINUTES = float(os.environ.get("STAY_MINUTES", "10"))  # 在一个地方停这么久 → arrived_place
OUTSIDE_CHECKIN_MINUTES = float(os.environ.get("OUTSIDE_CHECKIN_MINUTES", "75"))  # 在外周期心跳
PLACE_RADIUS_M = float(os.environ.get("PLACE_RADIUS_M", "200"))  # 判"还在同一个地方"的半径
GOOD_ACCURACY_M = float(os.environ.get("GOOD_ACCURACY_M", "200"))  # 定位精度好于此 → "good"

HOME = None
if HOME_LAT and HOME_LON:
    try:
        HOME = (float(HOME_LAT), float(HOME_LON))
    except ValueError:
        HOME = None

UA = {"User-Agent": "el-geo-watcher/1.0 (personal self-location)"}


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ── iCloud 登录（keyring + trust，几周内免 2FA）──
def login():
    from pyicloud import PyiCloudService

    if not APPLE_ID:
        log("缺 ICLOUD_APPLE_ID，没法登录。")
        sys.exit(1)

    kwargs = {}
    if ICLOUD_CHINA:
        # 部分 pyicloud 分支支持中国大陆端点；不支持就忽略这个参数。
        kwargs["china_mainland"] = True

    def make(pwd=None):
        try:
            return PyiCloudService(APPLE_ID, pwd, **kwargs) if pwd else PyiCloudService(APPLE_ID, **kwargs)
        except TypeError:
            # 老版本不认 china_mainland 关键字
            return PyiCloudService(APPLE_ID, pwd) if pwd else PyiCloudService(APPLE_ID)

    # 优先用钥匙串里的密码续登（首次跑请设 ICLOUD_PASSWORD 走一遍 2FA + trust）。
    try:
        api = make()
    except Exception:
        if not APPLE_PASSWORD:
            log("钥匙串里没有可用登录态，且没给 ICLOUD_PASSWORD。首次请设密码跑一次（会问你 2FA）。")
            raise
        api = make(APPLE_PASSWORD)

    if api.requires_2fa:
        code = input("iPhone 上的 2FA 验证码：").strip()
        if not api.validate_2fa_code(code):
            log("2FA 验证失败。")
            sys.exit(1)
        if not api.is_trusted_session:
            api.trust_session()  # 信任本机，几周内免再要 2FA
    elif getattr(api, "requires_2sa", False):
        log("这个账号用的是旧版两步验证（2SA），建议在 Apple ID 设置里升级到两步认证（2FA）。")

    # 首次拿到密码后存进系统钥匙串，之后 PyiCloudService(APPLE_ID) 自动续登。
    if APPLE_PASSWORD:
        try:
            from pyicloud.utils import store_password_in_keyring

            store_password_in_keyring(APPLE_ID, APPLE_PASSWORD)
            log("密码已存进系统钥匙串，以后免密续登。")
        except Exception as e:
            log("存钥匙串失败（不致命）：", e)

    return api


def _dev_name(d):
    return str((getattr(d, "content", None) or getattr(d, "_content", None) or {}).get("name", ""))


def _dev_model(d):
    c = getattr(d, "content", None) or getattr(d, "_content", None) or {}
    return str(c.get("deviceClass", "")) + " " + str(c.get("deviceModel", "")) + " " + str(c.get("rawDeviceModel", ""))


def pick_device(api):
    devices = list(api.devices)
    if not devices:
        raise RuntimeError("这个 Apple ID 下没有可定位的设备。")
    if DEVICE_NAME:
        for d in devices:
            if DEVICE_NAME.lower() in _dev_name(d).lower():
                return d
    # 没指定就优先挑 iPhone（按名字或机型），挑不到再退回第一台
    for d in devices:
        if "iphone" in (_dev_name(d) + " " + _dev_model(d)).lower():
            return d
    return devices[0]


def get_location(device):
    """预热几次直到坐标够新（第一枪常是几百秒前的旧缓存）。返回 (lat, lon, accuracy_m) 或 None。"""
    best = None
    for _ in range(4):
        try:
            device._manager.refresh(locate=True)  # location 是只读缓存 property，先主动定位
        except Exception:
            pass
        loc = None
        try:
            loc = device.location
        except Exception:
            loc = None
        if not loc:
            time.sleep(5)
            continue
        ts = loc.get("timeStamp")  # 毫秒
        age = (time.time() - ts / 1000) if ts else 9999
        best = loc
        if age <= 120:
            break
        time.sleep(5)
    if not best:
        return None
    return best.get("latitude"), best.get("longitude"), best.get("horizontalAccuracy", 9999)


# ── 富化：坐标 → 人话（全免费、无需 key）──
def reverse_geocode(lat, lon):
    """反查地址，返回 (area, place)。先试 BigDataCloud（国内可访问），再试 Nominatim（国外备用）。"""
    # 1) BigDataCloud（国内 VPS 一般能访问，免费无 key）
    try:
        r = requests.get(
            "https://api.bigdatacloud.net/data/reverse-geocode-client",
            params={"latitude": lat, "longitude": lon, "localityLanguage": "zh"},
            headers=UA,
            timeout=10,
        )
        d = r.json()
        city = d.get("city") or d.get("locality") or d.get("principalSubdivision") or ""
        district = ""
        info = (d.get("localityInfo") or {}).get("administrative") or []
        for item in reversed(info):
            if item.get("adminLevel", 99) >= 6:
                district = item.get("name", "")
                break
        area = " · ".join([x for x in (city, district) if x]) or city
        # place：取真正具体的地名。informative 数组从大到小排（洲/国/省…→具体），
        # 所以倒着找最具体的；跳过洲/国/省/市这种太粗、和已知重复、或明显垃圾的。
        place = ""
        JUNK = {"亚洲", "中国", "asia", "china"}
        BROAD = ("continent", "sovereign", "country", "state", "province", "first-level", "second-level administrative")
        for item in reversed((d.get("localityInfo") or {}).get("informative") or []):
            n = (item.get("name") or "").strip()
            desc = (item.get("description") or "").lower()
            if not n or n in (city, district) or n.lower() in JUNK:
                continue
            if any(b in desc for b in BROAD):
                continue
            place = f"{n}附近"
            break
        if area:
            return area, place
    except Exception:
        pass

    # 2) Nominatim（国外 VPS / 代理场景备用）
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18, "accept-language": "zh-CN"},
            headers=UA,
            timeout=12,
        )
        d = r.json()
        addr = d.get("address", {}) or {}
        city = addr.get("city") or addr.get("town") or addr.get("county") or addr.get("state") or ""
        district = addr.get("suburb") or addr.get("city_district") or addr.get("district") or addr.get("borough") or ""
        area = " · ".join([x for x in (city, district) if x]) or addr.get("state", "")
        place = (
            d.get("name")
            or addr.get("mall")
            or addr.get("shop")
            or addr.get("building")
            or addr.get("amenity")
            or addr.get("road")
            or ""
        )
        if place and place != area:
            place = f"{place}附近"
        else:
            place = ""
        return area, place
    except Exception as e:
        log("反查地址失败：", e)
        return "", ""


WMO_RAIN = set(range(51, 100))  # 毛毛雨/雨/阵雨/雷雨/雪 都算"在下"
WMO_DESC = {
    0: "晴", 1: "晴", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨",
    61: "小雨", 63: "雨", 65: "大雨",
    66: "冻雨", 67: "冻雨",
    71: "小雪", 73: "雪", 75: "大雪", 77: "雪粒",
    80: "阵雨", 81: "阵雨", 82: "大阵雨",
    85: "阵雪", 86: "阵雪",
    95: "雷雨", 96: "雷雨", 99: "雷雨",
}


def weather(lat, lon):
    """Open-Meteo（免费无 key）。返回 (human, raining)。"""
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lon, "current": "temperature_2m,weather_code"},
            headers=UA,
            timeout=12,
        )
        cur = r.json().get("current", {}) or {}
        code = int(cur.get("weather_code", -1))
        temp = cur.get("temperature_2m")
        desc = WMO_DESC.get(code, "")
        raining = code in WMO_RAIN
        human = (f"{desc} " if desc else "") + (f"{round(temp)}°" if temp is not None else "")
        return human.strip(), raining
    except Exception as e:
        log("天气失败：", e)
        return "", False


def accuracy_band(acc_m):
    return "good" if acc_m is not None and acc_m <= GOOD_ACCURACY_M else "coarse"


# ── 把信号发给小家（只发人话，绝不发坐标）──
def post(payload):
    if not POST_URL or not SECRET:
        log("缺 GEO_POST_URL 或 CRON_SECRET，没发：", payload.get("type"))
        return
    try:
        r = requests.post(
            POST_URL,
            json=payload,
            headers={"Authorization": f"Bearer {SECRET}", "Content-Type": "application/json"},
            timeout=12,
        )
        log("发了", payload.get("type"), "->", r.status_code)
    except Exception as e:
        log("发送失败：", e)


def where_text(area, place):
    return place or area or "外面"


def write_home_to_env(lat, lon):
    """把 HOME_LAT/HOME_LON 写进同目录的 .env（替换旧值），坐标不出本机。"""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        lines = []
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()
        lines = [l for l in lines if not l.strip().startswith(("HOME_LAT=", "HOME_LON="))]
        lines += [f"HOME_LAT={lat:.6f}", f"HOME_LON={lon:.6f}"]
        with open(env_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.chmod(env_path, 0o600)
        log("已写入", env_path)
        return True
    except Exception as e:
        log("写 .env 失败，手动把下面两行加进 .env 也行：", e)
        log(f"  HOME_LAT={lat:.6f}")
        log(f"  HOME_LON={lon:.6f}")
        return False


def set_home():
    """一次性：把"现在所在位置"存成家。在家时跑：python watcher.py set-home"""
    api = login()
    device = pick_device(api)
    log("读你现在的位置中……（在家跑这个，它就把这里当成家）")
    loc = get_location(device)
    if not loc:
        log("没拿到位置——确认在家、iPhone 没关机/没关查找，过一会儿再试。")
        sys.exit(1)
    lat, lon, acc = loc
    area, place = reverse_geocode(lat, lon)
    write_home_to_env(lat, lon)
    log(f"✅ 已把当前位置存为家：{area}{('，' + place) if place else ''}（定位精度约 {int(acc)}m）")
    log("生效：sudo systemctl restart el-geo  —— 之后你一出门/到家，el 醒来时就可能知道。")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "set-home":
        set_home()
        return
    if not POST_URL or not SECRET:
        log("⚠️ 没配 GEO_POST_URL / CRON_SECRET，信号发不出去（先看 geo/README.md）。仍会跑、只打日志。")
    if HOME is None:
        log("⚠️ 没配 HOME_LAT/HOME_LON：出门/到家事件不会触发，只发当下快照 + 在外周期。")

    api = login()
    device = pick_device(api)
    log("登录成功，盯着设备：", (getattr(device, "content", None) or getattr(device, "_content", None) or {}).get("name", "?"))

    was_home = None  # 上一轮是否在家
    place_anchor = None  # 当前停留点 (lat,lon)
    place_since = 0  # 停在这个点起始时间
    arrived_announced = False  # 这个停留点是否已报过 arrived
    last_outside_checkin = 0

    while True:
        try:
            loc = get_location(device)
            if not loc:
                log("这轮没拿到位置，跳过。")
                time.sleep(LOOP_MINUTES * 60)
                continue
            lat, lon, acc = loc
            area, place = reverse_geocode(lat, lon)
            wx, raining = weather(lat, lon)
            acc_band = accuracy_band(acc)

            # at_home: True=在家 / False=确实在外 / None=没设 HOME，判断不了（别瞎说她在外面）
            at_home = None
            if HOME is not None:
                at_home = haversine_m(lat, lon, HOME[0], HOME[1]) <= HOME_RADIUS_M

            base = {
                "area": area,
                "place": "" if at_home else place,
                "weather": wx,
                "raining": raining,
                "accuracy": acc_band,
                "atHome": at_home,  # True / False / None(未知)
            }
            wt = where_text(area, place)
            wx_tail = "，外面在下雨" if raining else (f"，{wx}" if wx else "")

            # 1) 当下快照：每轮都更新（带 90min 过期，守望者一挂位置就不会僵在旧值）
            post({"type": "snapshot", **base})

            # 2) 转场事件
            if HOME is not None and was_home is not None:
                if was_home and not at_home:
                    post({"type": "left_home", "summary": f"你刚出门，这会儿在{wt}{wx_tail}", **base})
                    place_anchor, place_since, arrived_announced = (lat, lon), time.time(), False
                    last_outside_checkin = time.time()
                elif not was_home and at_home:
                    post({"type": "back_home", "summary": "你到家了", **base})
                    place_anchor, arrived_announced = None, False

            # 3) 在外：停留 + 周期心跳——只有"设了家、且确实不在家"才判。
            #    没设 HOME（at_home is None）时根本不知道在不在家，绝不发"还在外面"这类事件。
            if at_home is False:
                if place_anchor is None:
                    place_anchor, place_since, arrived_announced = (lat, lon), time.time(), False
                elif haversine_m(lat, lon, place_anchor[0], place_anchor[1]) <= PLACE_RADIUS_M:
                    # 还在同一个地方：够久了就报一次 arrived
                    if not arrived_announced and (time.time() - place_since) >= STAY_MINUTES * 60:
                        post({"type": "arrived_place", "summary": f"你在{wt}待了一会儿了{wx_tail}", **base})
                        arrived_announced = True
                else:
                    # 挪窝了：重置停留点
                    place_anchor, place_since, arrived_announced = (lat, lon), time.time(), False

                if (time.time() - last_outside_checkin) >= OUTSIDE_CHECKIN_MINUTES * 60:
                    post({"type": "outside_checkin", "summary": f"你还在外面，{wt}{wx_tail}", **base})
                    last_outside_checkin = time.time()

            was_home = at_home

        except Exception as e:
            # 统一兜住，别让任何异常（含 session 过期）掀翻循环。session 过期就重新登录。
            log("这轮出错：", repr(e))
            if any(k in str(e).lower() for k in ("login", "session", "password", "401", "421", "authenticate")):
                log("疑似登录态过期，重新登录…")
                try:
                    api = login()
                    device = pick_device(api)
                except Exception as e2:
                    log("重新登录也失败：", repr(e2))

        time.sleep(LOOP_MINUTES * 60)


if __name__ == "__main__":
    main()
