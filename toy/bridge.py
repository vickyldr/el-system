"""
el-toy-bridge — Python BLE 控制 SVAKOM 玩具
依赖: pip install bleak aiohttp

用法:
  set BRIDGE_URL=https://你的railway地址
  set BRIDGE_SECRET=你的密钥
  python bridge.py
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

WRITE_UUID = "0000ae01-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ae02-0000-1000-8000-00805f9b34fb"

H = 0x55

def cmd_scale(v):
    return bytes([H, 4, 0, 0, 1, max(0, min(255, v)), 0xAA])

def cmd_suck(v):
    return bytes([H, 9, 0, 0, 1, max(0, min(255, v)), 0xAA])

def cmd_stretch(v):
    return bytes([H, 8, 0, 0, 1, max(0, min(10, v)), 0])

def cmd_stop_all():
    return [
        bytes([H, 4, 0, 0, 0, 0, 0xAA]),
        bytes([H, 3, 0, 0, 0, 0, 0]),
        bytes([H, 8, 0, 0, 0, 0, 0]),
        bytes([H, 9, 0, 0, 0, 0, 0xAA]),
    ]

cmd_queue = asyncio.Queue()
ble_client = None

async def exec_cmd(c: dict):
    if not ble_client or not ble_client.is_connected:
        return
    try:
        if c.get("stop"):
            for b in cmd_stop_all():
                await ble_client.write_gatt_char(WRITE_UUID, b, response=False)
                await asyncio.sleep(0.08)
            print("⏹ 全部停止")
            return
        if "speed" in c:
            await ble_client.write_gatt_char(WRITE_UUID, cmd_scale(int(c["speed"] * 255)), response=False)
            print(f"📳 强度 {int(c['speed']*100)}%")
        if "suck" in c:
            await ble_client.write_gatt_char(WRITE_UUID, cmd_suck(int(c["suck"] * 255)), response=False)
            print(f"💨 吸吮 {int(c['suck']*100)}%")
        if "thrust" in c:
            await ble_client.write_gatt_char(WRITE_UUID, cmd_stretch(int(c["thrust"] * 10)), response=False)
            print(f"🔀 抽插 {int(c['thrust']*100)}%")
    except Exception as e:
        print(f"写入失败: {e}")

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

async def ble_loop():
    global ble_client

    while True:
        print("🔍 扫描 SVAKOM 设备...")
        devices = await BleakScanner.discover(timeout=5.0)
        device = next(
            (d for d in devices if d.name and any(k in d.name for k in ["SL278", "SVAKOM", "svakom"])),
            None
        )

        if not device:
            print("⚠️ 未找到设备，5秒后重试...")
            await asyncio.sleep(5)
            continue

        print(f"🎮 发现: {device.name} [{device.address}]，连接中...")
        try:
            async with BleakClient(device.address) as client:
                ble_client = client
                print(f"✅ 已连接: {device.name}")

                await client.start_notify(NOTIFY_UUID, lambda s, d: None)
                await asyncio.sleep(0.5)
                # 连接后只发停止，不发强度脉冲避免断连
                for b in cmd_stop_all():
                    await client.write_gatt_char(WRITE_UUID, b, response=False)
                    await asyncio.sleep(0.08)

                print(f"🎉 {device.name} 就绪，daddy 可以控制了")

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

        print("❌ 设备断开，重新扫描...")
        await asyncio.sleep(2)

async def main():
    await asyncio.gather(bridge_loop(), ble_loop())

if __name__ == "__main__":
    asyncio.run(main())
