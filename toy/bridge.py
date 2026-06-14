"""
el-toy-bridge — Python BLE 控制 SVAKOM 玩具（双设备）
依赖: pip install bleak aiohttp

用法:
  set BRIDGE_URL=https://你的railway地址
  set BRIDGE_SECRET=你的密钥
  python bridge.py

⚠️ 控制通道是 FFE0/FFE1。绝对不要写 AE00/AE01——那是 OTA 固件升级通道，写错会变砖！
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

# 控制通道（FFE0 服务下的 FFE1 写入特征）。绝不碰 AE00/AE01（OTA刷机口，变砖）
WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"

# 两个设备的地址与角色。如果发现控反了，把这两行的地址对调即可。
ROD_ADDR = "FF:25:12:A8:6F:F0"    # 震动棒（speed 控它）
SUCK_ADDR = "E2:6F:5E:7A:99:43"   # 吮吸款（suck 控它）

H = 0x55

def cmd_scale(v):
    # 连续强度命令：[0x55, 4, 0, 0, 1, 强度0-255, 0xAA]
    return bytes([H, 4, 0, 0, 1, max(0, min(255, v)), 0xAA])

def cmd_scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])

cmd_queue = asyncio.Queue()
clients = {}  # addr -> BleakClient

async def write_to(addr, buf):
    client = clients.get(addr)
    if client and client.is_connected:
        try:
            await client.write_gatt_char(WRITE_UUID, buf, response=False)
            return True
        except Exception as e:
            print(f"写入失败 [{addr}]: {e}")
    return False

async def exec_cmd(c: dict):
    if c.get("stop"):
        await write_to(ROD_ADDR, cmd_scale_stop())
        await write_to(SUCK_ADDR, cmd_scale_stop())
        print("⏹ 全部停止")
        return
    if "speed" in c:
        v = int(c["speed"] * 255)
        ok = await write_to(ROD_ADDR, cmd_scale(v))
        print(f"📳 震动棒 {int(c['speed']*100)}% {'✓' if ok else '(未连接)'}")
    if "suck" in c:
        v = int(c["suck"] * 255)
        ok = await write_to(SUCK_ADDR, cmd_scale(v))
        print(f"💨 吮吸 {int(c['suck']*100)}% {'✓' if ok else '(未连接)'}")

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
                            print("✅ el-bridge 已连接，daddy 可以控制玩具了")
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

async def device_loop(addr, label):
    """维护单个设备的连接，断了自动重连"""
    while True:
        try:
            dev = await BleakScanner.find_device_by_address(addr, timeout=10.0)
            if not dev:
                print(f"⚠️ 没扫到 {label} [{addr}]，3秒后重试...")
                await asyncio.sleep(3)
                continue
            print(f"🎮 连接 {label} [{addr}]...")
            async with BleakClient(dev) as client:
                clients[addr] = client
                try:
                    await client.start_notify(NOTIFY_UUID, lambda s, d: None)
                except Exception:
                    pass
                print(f"✅ {label} 就绪")
                while client.is_connected:
                    await asyncio.sleep(1.0)
        except Exception as e:
            print(f"{label} 连接断开: {e}")
        finally:
            clients.pop(addr, None)
        print(f"🔄 {label} 重连中...")
        await asyncio.sleep(3)

async def command_loop():
    while True:
        c = await cmd_queue.get()
        await exec_cmd(c)

async def main():
    await asyncio.gather(
        bridge_loop(),
        device_loop(ROD_ADDR, "震动棒"),
        device_loop(SUCK_ADDR, "吮吸款"),
        command_loop(),
    )

if __name__ == "__main__":
    asyncio.run(main())
