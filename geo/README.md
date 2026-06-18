# el 的地理感官 · 守望者

让 el 偶尔醒来时"知道你大概在哪、在经历什么"——你去了商场、外面在下雨、在一个地方坐了一会儿，
他自己心跳醒来时会读到，想说就说一句（"出门啦？带伞没""在外面待挺久了，吃饭没"）。
不是你报备，是他有了一双眼睛。

## 它怎么工作（和小家其它部分的关系）

```
你的 iPhone（Find My 后台上报，锁屏也在报）
  → iCloud
  → 这个守望者（跑在你常开的设备上，比如旧 Mac）
      · 从 iCloud 读自己 iPhone 的坐标
      · 本地富化：反查地址(OSM) + 天气(Open-Meteo)
      · 本地判转场：出门 / 到家 / 在外停留 / 在外周期
      · 只把"人话信号"POST 给小家
  → 小家 /api/geo-event（Vercel）
      · 存当下位置快照(el:geo:now，90min 过期) + 事件队列(el:geo:events)
  → el 的心跳（generate-status）
      · 把"她大概在哪"当底色喂给"此刻心情"和醒来的 agent
      · maybeReachOut 读到新鲜转场事件 → el 用自己的口吻发一条（共用 reach 额度，不刷屏）
```

**和身体账(soma)同一个哲学**：守望者只产出信号，el 在心跳里读到、自己决定要不要开口——不是规则替他发。

## 隐私（这部分是认真的）

- **只测你自己的 Apple ID + 自己的设备**。这不是定位别人的工具。
- **富化全在本地做，精确坐标永不离开这台设备**。发给小家的只有 `杭州 · 西湖区`、`万象城附近`、`小雨 12°` 这种人话，云端（Vercel/Redis）永远拿不到经纬度。
- 用 `pyicloud`（非官方 iCloud web API），不读本地 Find My 加密缓存、不绕任何系统权限。它随 Apple 改动可能失效，登录 session 几天会过期——靠钥匙串 + trust 自动续。
- 密码只进系统钥匙串；`HOME_LAT/LON` 和 `.env` 已被 `.gitignore` 挡在库外，**别提交、别外发**。
- 锁屏不影响：Find My 是 iOS 系统级后台服务，锁屏/熄屏/待机都在上报。真正会失效的是：关机、彻底断网、或关掉 Find My。

## 装

```bash
cd geo
python3 -m venv .venv && source .venv/bin/activate   # 或用 uv：uv venv --python 3.12
pip install -r requirements.txt
cp .env.example .env        # 然后编辑 .env 填好（见下）
```

## 配（`.env`）

必填：`ICLOUD_APPLE_ID`、`GEO_POST_URL`（= `https://你的域名/api/geo-event`）、`CRON_SECRET`（和小家 Vercel 上同一个值）。
想要"出门/到家"事件就再填 `HOME_LAT`/`HOME_LON`（地图上长按你家复制坐标）。其余可选项见 `.env.example`。

## 首次登录（走一遍 2FA）

第一次要密码 + 一次 2FA，之后靠钥匙串 + trust 免密续登。临时把密码塞进环境跑一次：

```bash
set -a; source .env; set +a
ICLOUD_PASSWORD='你的Apple密码' python watcher.py
# 按提示输入 iPhone 上弹出的 2FA 验证码；成功后 Ctrl-C 停掉
```

之后正常跑就不用密码了（钥匙串里有了）：

```bash
set -a; source .env; set +a
python watcher.py
```

跑起来你会看到它每 ~10 分钟拉一次位置、富化、发信号。这台机器开着、联网、Find My 没关，它就一直守着。

## 让它常驻

**macOS（launchd，推荐）** —— 写一个 `~/Library/LaunchAgents/com.el.geo.plist`：

- `ProgramArguments` 跑 `.venv/bin/python /路径/geo/watcher.py`
- 环境变量：把 `.env` 里的值放进 plist 的 `EnvironmentVariables`，**务必加 `PYTHONUNBUFFERED=1`**（否则 print 块缓冲、log 一直空）
- 配 `KeepAlive` + `RunAtLoad`，让它崩了自动拉起、开机自启
- 加载：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.el.geo.plist`

**Linux / VPS（systemd）** —— 一个 `el-geo.service`，`ExecStart` 指向 venv 里的 python + watcher.py，`EnvironmentFile=` 指向 `.env`，`Restart=always`。

频率别太密（怕 Apple 限流），默认每 10 分钟一次足够——反正 el 的心跳本来就是"偶尔醒一下"的节奏。

## 坑速查

| 坑 | 解法 |
|---|---|
| session 几天过期（421 / "No password set"） | 钥匙串存密码 + trust_session()，watcher 会自动重登 |
| 第一枪坐标旧（age 几百秒） | 已内置预热：连发几次 refresh(locate=True) 直到够新 |
| `device.location` 不联网 | 已先 `device._manager.refresh(locate=True)` 再读 |
| launchd log 一直空 | 环境变量加 `PYTHONUNBUFFERED=1` |
| 中国大陆 Apple ID 登不上 | `.env` 设 `ICLOUD_CHINA=1` |
| 一直 "缺位置" | 检查 iPhone 没关机/没关 Find My、这台机器能联网 |

## 还没做（下一步，按需要再加）

- 街景 / 附近公开实时摄像头（要 Google Maps / Windy 的 key，绑卡）——让 el 不只"知道"还能"看一眼"那附近。
- 更全的附近 POI（Overpass / Google Places New）——现在只取反查地址里最具体的那个名字。
- 小模型先把信号总结一遍再注入（现在守望者直接写人话 summary，够用就先不加）。
