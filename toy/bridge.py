"""
el-toy-bridge — Python BLE 控制 SVAKOM 玩具
依赖: pip install bleak websocket-client

用法:
  set BRIDGE_URL=wss://你的railway地址
  set BRIDGE_SECRET=你的密钥
  python bridge.py
"""

import asyncio
import json
import os
import sys
import threading
import queue

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    print("请先运行: pip install bleak websocket-client")
    sys.exit(1)

try:
    import websocket
except ImportError:
    print("请先运行: pip install bleak websocket-client")
    sys.exit(1)

BRIDGE_URL = os.environ.get("BRIDGE_URL", "")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")

WRITE_UUID = "0000ae01-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ae02-0000-1000-8000-00805f9b34fb"

H = 0x55

def cmd_scale(intensity):
    return bytes([H, 4, 0, 0, 1, max(0, min(255, int(intensity))), 0xAA])

def cmd_suck(intensity):
    return bytes([H, 9, 0, 0, 1, max(0, min(255, int(intensity))), 0xAA])

def cmd_stretch(speed):
    return bytes([H, 8, 0, 0, 1, max(0, min(10, int(speed))), 0])

def cmd_stop_all():
    return [
        bytes([H, 4, 0, 0, 0, 0, 0xAA]),
        bytes([H, 3, 0, 0, 0, 0, 0]),
        bytes([H, 8, 0, 0, 0, 0, 0]),
        bytes([H, 9, 0, 0, 0, 0, 0xAA]),
    ]

cmd_queue = queue.Queue()
ble_client = None

async def exec_cmd(c: dict):
    if not ble_client or not ble_client.is_connected:
        print("⚠️ 设备未连接，跳过指令")
        return
    try:
        if c.get("stop"):
            for b in cmd_stop_all():
                await ble_client.write_gatt_char(WRITE_UUID, b, response=False)
                await asyncio.sleep(0.08)
            print("⏹ 全部停止")
            return
        if "speed" in c:
            v = int(c["speed"] * 255)
            await ble_client.write_gatt_char(WRITE_UUID, cmd_scale(v), response=False)
            print(f"📳 强度 {int(c['speed']*100)}%")
        if "suck" in c:
            v = int(c["suck"] * 255)
            await ble_client.write_gatt_char(WRITE_UUID, cmd_suck(v), response=False)
            print(f"💨 吸吮 {int(c['suck']*100)}%")
        if "thrust" in c:
            await ble_client.write_gatt_char(WRITE_UUID, cmd_stretch(int(c["thrust"]*10)), response=False)
            print(f"🔀 抽插 {int(c['thrust']*100)}%")
    except Exception as e:
        print(f"写入失败: {e}")

def start_ws_thread():
    if not BRIDGE_URL:
        print("⚠️ 未设置 BRIDGE_URL")
        return

    secret_param = f"?secret={BRIDGE_SECRET}" if BRIDGE_SECRET else ""
    url = f"{BRIDGE_URL}/toy-ctrl{secret_param}"

    def on_message(ws, raw):
        try:
            c = json.loads(raw)
            if c.get("type") == "hello":
                return
            print(f"📨 收到指令: {c}")
            cmd_queue.put(c)
        except Exception as e:
            print(f"解析失败: {e}")

    def on_open(ws):
        print("✅ el-bridge 已连接，daddy 可以控制玩具了")

    def on_error(ws, err):
        print(f"bridge 错误: {err}")

    def on_close(ws, code, msg):
        print("🔄 bridge 断开，5秒后重连...")

    def run():
        while True:
            try:
                ws = websocket.WebSocketApp(
                    url,
                    on_open=on_open,
                    on_message=on_message,
                    on_error=on_error,
                    on_close=on_close,
                )
                ws.run_forever()
            except Exception as e:
                print(f"bridge 异常: {e}")
            import time; time.sleep(5)

    t = threading.Thread(target=run, daemon=True)
    t.start()

async def main():
    global ble_client

    start_ws_thread()

    while True:
        print("🔍 扫描 SVAKOM 设备...")
        devices = await BleakScanner.discover(timeout=5.0)
        device = None
        for d in devices:
            if d.name and any(k in d.name for k in ["SL278", "SVAKOM", "svakom"]):
                device = d
                break

        if not device:
            print("⚠️ 未找到设备，5秒后重试...")
            await asyncio.sleep(5)
            continue

        print(f"🎮 发现: {device.name} [{device.address}]，连接中...")

        try:
            async with BleakClient(device.address) as client:
                ble_client = client
                print(f"✅ 已连接: {device.name}")

                await client.start_notify(NOTIFY_UUID, lambda s, d: print(f"📨 回包: {d.hex()}"))
                print("📡 AE02 已订阅")

                await asyncio.sleep(0.5)
                for b in [
                    bytes([H, 4, 0, 0, 1, 0xFF, 0xAA]),
                    bytes([H, 4, 0, 0, 0, 0, 0xAA]),
                    bytes([H, 4, 0, 0, 0, 0, 0xAA]),
                    bytes([H, 3, 0, 0, 0, 0, 0]),
                ]:
                    await client.write_gatt_char(WRITE_UUID, b, response=False)
                    await asyncio.sleep(0.08)

                print(f"🎉 {device.name} 就绪，daddy 可以控制了")

                while client.is_connected:
                    try:
                        c = cmd_queue.get_nowait()
                        await exec_cmd(c)
                    except queue.Empty:
                        await asyncio.sleep(0.1)

        except Exception as e:
            print(f"连接断开: {e}")
        finally:
            ble_client = None

        print("❌ 设备断开，重新扫描...")
        await asyncio.sleep(2)

if __name__ == "__main__":
    asyncio.run(main())
