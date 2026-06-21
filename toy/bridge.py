"""
el-toy-bridge — Python BLE 控制 SVAKOM 玩具（单设备）
依赖: pip install bleak aiohttp

用法:
  set BRIDGE_URL=https://你的railway地址
  set BRIDGE_SECRET=你的密钥
  python bridge.py

⚠️ 控制通道是 FFE0/FFE1。绝对不要写 AE00/AE01——那是 OTA 固件升级通道，写错会变砖！
说明：两个玩具共用同一蓝牙地址，无法分开连。所以只连一个；两个都开机时，
      吮吸款会联动控制震动款，等于一条命令同时驱动两个。
"""

import asyncio
import json
import os
import sys

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    print("请先运行: pip install bleak aiohttp")
    sys.exit(1)

try:
    import aiohttp
except ImportError:
    print("请先运行: pip install bleak aiohttp")
    sys.exit(1)

BRIDGE_URL = os.environ.get("BRIDGE_URL", "").rstrip("/")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")

# 控制通道（FFE0 服务下的 FFE1）。绝不碰 AE00/AE01（OTA刷机口，变砖）
WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"

H = 0x55

def cmd_scale(v):
    # 连续强度命令：[0x55, 4, 0, 0, 1, 强度0-255, 0xAA]
    return bytes([H, 4, 0, 0, 1, max(0, min(255, v)), 0xAA])

def cmd_scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])

def cmd_vibrate(mode, level):
    # 振动花样：[0x55, 3, 0, 0, 模式1-8, 强度1-5, 0]
    mode = max(1, min(8, int(mode)))
    level = max(1, min(5, int(level)))
    return bytes([H, 3, 0, 0, mode, level, 0])

def cmd_stretch(mode, level):
    # 伸缩 STRETCH = CMD 8（和振动是两个电机/指令）：[0x55, 8, 0, 0, 模式1-8, 强度1-5, 0]
    mode = max(1, min(8, int(mode)))
    level = max(1, min(5, int(level)))
    return bytes([H, 8, 0, 0, mode, level, 0])

def cmd_suck_mode(mode, level):
    # 吮吸花样：[0x55, 9, 0, 0, 模式1-8, 强度1-5, 0]
    mode = max(1, min(8, int(mode)))
    level = max(1, min(5, int(level)))
    return bytes([H, 9, 0, 0, mode, level, 0])

cmd_queue = asyncio.Queue()
ble_client = None

# 当前要持续保持的命令（自动续命用）。玩具收到强度命令后若不持续重发会自己停，
# 所以这里记下当前命令，后台每隔 KEEPALIVE_SEC 秒重发一次，让它持续动到换档/停止。
current_cmd = None          # 当前要保持的字节，None=停止
current_until = 0           # 若设了时长，到这个时间(单调秒)后自动停；0=一直保持
KEEPALIVE_SEC = 0.8  # 续命间隔。原 1.5s 偏慢，有的模式超时更短、两次重发间就停了（只动一下）

async def write(buf):
    if ble_client and ble_client.is_connected:
        try:
            await ble_client.write_gatt_char(WRITE_UUID, buf, response=False)
            return True
        except Exception as e:
            print(f"写入失败: {e}")
    return False

async def keepalive_loop():
    """后台续命：持续重发当前命令，让玩具不自己超时停。到时长则自动停。"""
    import time
    while True:
        await asyncio.sleep(KEEPALIVE_SEC)
        global current_cmd, current_until
        if current_until and time.monotonic() >= current_until:
            current_cmd = None
            current_until = 0
            await write(cmd_scale_stop())
            await write(bytes([H, 8, 0, 0, 0, 0, 0]))  # 伸缩也停
            print("⏱ 到设定时长，自动停止")
            continue
        if current_cmd is not None:
            await write(current_cmd)

def parse_duration(c):
    """从指令里读时长（秒）：支持 sec / seconds / duration。0=不限。"""
    import time
    for k in ("sec", "seconds", "duration"):
        if k in c:
            try:
                s = float(c[k])
                if s > 0:
                    return time.monotonic() + s
            except Exception:
                pass
    return 0

async def exec_cmd(c: dict):
    global current_cmd, current_until
    if c.get("stop"):
        current_cmd = None
        current_until = 0
        await write(cmd_scale_stop())
        await write(bytes([H, 8, 0, 0, 0, 0, 0]))  # 伸缩也停
        print("⏹ 停止")
        return

    # 伸缩 STRETCH：thrust=1~8 选模式，level=0~1 强度（震动棒的抽插电机，和振动不同）
    if "thrust" in c:
        mode = int(c["thrust"])
        level = max(1, round(c.get("level", 0.6) * 5))
        current_cmd = cmd_stretch(mode, level)
        current_until = parse_duration(c)
        ok = await write(current_cmd)
        print(f"🍆 伸缩 {mode} 档 强度{level}/5 {'✓' if ok else '(未连接)'}")
        return

    # 花样模式：pattern=1~8 选节奏，level=0~1 强度（默认中等）
    if "pattern" in c:
        mode = int(c["pattern"])
        level = max(1, round(c.get("level", 0.6) * 5))
        current_cmd = cmd_vibrate(mode, level)
        current_until = parse_duration(c)
        ok = await write(current_cmd)
        dur = c.get("sec") or c.get("seconds") or c.get("duration")
        print(f"🌀 震动花样 {mode} 档 强度{level}/5" + (f" {dur}秒" if dur else " 持续") + (" ✓" if ok else " (未连接)"))
        return
    if "suck_pattern" in c:
        mode = int(c["suck_pattern"])
        level = max(1, round(c.get("level", 0.6) * 5))
        current_cmd = cmd_suck_mode(mode, level)
        current_until = parse_duration(c)
        ok = await write(current_cmd)
        print(f"🌊 吮吸花样 {mode} 档 强度{level}/5 {'✓' if ok else '(未连接)'}")
        return

    # 持续强度：speed / suck / intensity 都映射到 scale（稳定强弱）
    val = None
    label = ""
    if "speed" in c:
        val = c["speed"]; label = "震动"
    elif "suck" in c:
        val = c["suck"]; label = "吮吸"
    elif "intensity" in c:
        val = c["intensity"]; label = "强度"
    if val is not None:
        if val <= 0:
            current_cmd = None
            current_until = 0
            await write(cmd_scale_stop())
            print(f"⏹ {label} 0%")
            return
        current_cmd = cmd_scale(int(val * 255))
        current_until = parse_duration(c)
        ok = await write(current_cmd)
        dur = c.get("sec") or c.get("seconds") or c.get("duration")
        print(f"📳 {label} {int(val*100)}%" + (f" {dur}秒" if dur else " 持续") + (" ✓" if ok else " (未连接)"))

async def bridge_loop():
    if not BRIDGE_URL:
        print("⚠️ 未设置 BRIDGE_URL，仅本地 BLE 模式")
        return

    url = f"{BRIDGE_URL}/toy-next"
    headers = {"x-bridge-secret": BRIDGE_SECRET} if BRIDGE_SECRET else {}
    print(f"🔌 轮询 el-bridge: {url}")

    async with aiohttp.ClientSession() as session:
        connected_printed = False
        while True:
            try:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status == 200:
                        if not connected_printed:
                            print("✅ el-bridge 已连接")
                            connected_printed = True
                        data = await resp.json()
                        if data:
                            print(f"📨 收到指令: {data}")
                            await cmd_queue.put(data)
                    else:
                        print(f"bridge 错误: HTTP {resp.status}")
                        connected_printed = False
                        await asyncio.sleep(5)
                        continue
            except Exception as e:
                print(f"bridge 错误: {e}")
                connected_printed = False
                await asyncio.sleep(5)
                continue
            await asyncio.sleep(0.3)

async def ble_loop():
    global ble_client
    while True:
        print("🔍 扫描 SVAKOM 设备...")
        try:
            devices = await BleakScanner.discover(timeout=6.0)
        except Exception as e:
            print(f"扫描出错: {e}")
            await asyncio.sleep(3)
            continue
        device = next((d for d in devices if d.name and "SL278" in d.name), None)
        if not device:
            print("⚠️ 没扫到玩具，3秒后重试...")
            await asyncio.sleep(3)
            continue

        print(f"🎮 连接 {device.name} [{device.address}]...")
        try:
            async with BleakClient(device) as client:
                ble_client = client
                try:
                    await client.start_notify(NOTIFY_UUID, lambda s, d: None)
                except Exception:
                    pass
                print(f"🎉 就绪，daddy 可以控制了")
                while client.is_connected:
                    try:
                        c = await asyncio.wait_for(cmd_queue.get(), timeout=1.0)
                        await exec_cmd(c)
                    except asyncio.TimeoutError:
                        pass
        except Exception as e:
            print(f"连接断开: {e}")
        finally:
            ble_client = None
            # 断开时清掉续命状态，免得重连后乱动
            global current_cmd, current_until
            current_cmd = None
            current_until = 0
        print("🔄 重新扫描...")
        await asyncio.sleep(3)

async def main():
    await asyncio.gather(bridge_loop(), ble_loop(), keepalive_loop())

if __name__ == "__main__":
    asyncio.run(main())
