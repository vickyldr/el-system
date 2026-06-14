"""
el-toy-bridge — Python BLE 控制 SVAKOM 玩具
依赖: pip install bleak websockets

用法:
  set BRIDGE_URL=wss://你的railway地址
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
    print("请先运行: pip install bleak websockets")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("请先运行: pip install bleak websockets")
    sys.exit(1)

BRIDGE_URL = os.environ.get("BRIDGE_URL", "")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")

WRITE_UUID = "0000ae01-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ae02-0000-1000-8000-00805f9b34fb"
SERVICE_UUID = "0000ae00-0000-1000-8000-00805f9b34fb"

H = 0x55  # PROTOCOL_HEADER

def cmd_scale(intensity):
    v = max(0, min(255, int(intensity)))
    return bytes([H, 4, 0, 0, 1, v, 0xAA])

def cmd_scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])

def cmd_vibrate(mode, speed):
    return bytes([H, 3, 0, 0, mode, speed, 0])

def cmd_vibrate_stop():
    return bytes([H, 3, 0, 0, 0, 0, 0])

def cmd_stretch(mode, speed):
    return bytes([H, 8, 0, 0, mode, speed, 0])

def cmd_stretch_stop():
    return bytes([H, 8, 0, 0, 0, 0, 0])

def cmd_suck(intensity):
    v = max(0, min(255, int(intensity)))
    return bytes([H, 9, 0, 0, 1, v, 0xAA])

def cmd_suck_stop():
    return bytes([H, 9, 0, 0, 0, 0, 0xAA])

def cmd_stop_all():
    return [
        bytes([H, 4, 0, 0, 0, 0, 0xAA]),
        bytes([H, 3, 0, 0, 0, 0, 0]),
        bytes([H, 8, 0, 0, 0, 0, 0]),
        bytes([H, 9, 0, 0, 0, 0, 0xAA]),
    ]

client: BleakClient = None

async def write(buf: bytes):
    if client and client.is_connected:
        await client.write_gatt_char(WRITE_UUID, buf, response=False)

async def exec_cmd(c: dict):
    if c.get("stop"):
        for b in cmd_stop_all():
            await write(b)
            await asyncio.sleep(0.08)
        print("⏹ 全部停止")
        return

    if "speed" in c:
        v = int(c["speed"] * 255)
        await write(cmd_scale(v))
        print(f"📳 强度 {int(c['speed']*100)}%")

    if "suck" in c:
        v = int(c["suck"] * 255)
        await write(cmd_suck(v))
        print(f"💨 吸吮 {int(c['suck']*100)}%")

    if "thrust" in c:
        speed = int(c["thrust"] * 10)
        await write(cmd_stretch(1, speed))
        print(f"🔀 抽插 {int(c['thrust']*100)}%")

async def connect_toy():
    global client
    print("🔍 扫描 SVAKOM 设备...")

    device = None
    scanner = BleakScanner()
    await scanner.start()
    await asyncio.sleep(5)
    await scanner.stop()

    for d in scanner.discovered_devices:
        name = d.name or ""
        if any(k in name for k in ["SL278", "SVAKOM", "svakom"]):
            device = d
            break

    if not device:
        print("⚠️ 未找到设备，5秒后重试...")
        await asyncio.sleep(5)
        return False

    print(f"🎮 发现: {device.name} [{device.address}]，连接中...")
    client = BleakClient(device.address, disconnected_callback=on_disconnect)

    try:
        await client.connect()
        print(f"✅ 已连接: {device.name}")

        await client.start_notify(NOTIFY_UUID, on_notify)
        print("📡 AE02 通知已订阅")

        # 初始化序列
        await asyncio.sleep(0.5)
        init_seq = [
            bytes([H, 4, 0, 0, 1, 0xFF, 0xAA]),
            bytes([H, 4, 0, 0, 0, 0, 0xAA]),
            bytes([H, 4, 0, 0, 0, 0, 0xAA]),
            bytes([H, 3, 0, 0, 0, 0, 0]),
        ]
        for b in init_seq:
            await write(b)
            await asyncio.sleep(0.08)

        print(f"🎉 {device.name} 就绪，daddy 可以控制了")
        return True

    except Exception as e:
        print(f"连接失败: {e}")
        return False

disconnect_event = asyncio.Event()

def on_disconnect(c):
    global client
    print("❌ 设备断开，重新扫描...")
    client = None
    disconnect_event.set()

def on_notify(sender, data):
    print(f"📨 设备回包: {data.hex()}")

async def bridge_loop(cmd_queue: asyncio.Queue):
    if not BRIDGE_URL:
        print("⚠️ 未设置 BRIDGE_URL，仅本地 BLE 模式")
        return

    secret_param = f"?secret={BRIDGE_SECRET}" if BRIDGE_SECRET else ""
    url = f"{BRIDGE_URL}/toy-ctrl{secret_param}"

    while True:
        try:
            print("🔌 连接 el-bridge...")
            async with websockets.connect(url, compression=None) as ws:
                print("✅ el-bridge 已连接，daddy 可以控制玩具了")
                async for msg in ws:
                    try:
                        c = json.loads(msg)
                        if c.get("type") == "hello":
                            continue
                        print(f"📨 收到指令: {c}")
                        await cmd_queue.put(c)
                    except Exception as e:
                        print(f"解析失败: {e}")
        except Exception as e:
            print(f"bridge 错误: {e}，5秒后重连...")
            await asyncio.sleep(5)

async def main():
    cmd_queue = asyncio.Queue()

    # 启动 bridge WebSocket（后台）
    asyncio.create_task(bridge_loop(cmd_queue))

    while True:
        ok = await connect_toy()
        if ok:
            disconnect_event.clear()
            # 处理指令直到断开
            while client and client.is_connected:
                try:
                    c = await asyncio.wait_for(cmd_queue.get(), timeout=1.0)
                    await exec_cmd(c)
                except asyncio.TimeoutError:
                    pass
            await disconnect_event.wait()
        await asyncio.sleep(2)

if __name__ == "__main__":
    asyncio.run(main())
