"""
识别设备 — 让 E2:6F:5E:7A:99:43 这个设备动 5 秒
看是震动棒还是吮吸款动了，告诉 daddy
用法: python identify.py
"""

import asyncio
from bleak import BleakClient, BleakScanner

ADDR = "E2:6F:5E:7A:99:43"
WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
H = 0x55

async def main():
    print("先扫描定位设备...")
    dev = await BleakScanner.find_device_by_address(ADDR, timeout=10.0)
    if not dev:
        print(f"⚠️ 没扫到 {ADDR}，确认它开着")
        return
    print(f"连接 {ADDR}...")
    async with BleakClient(dev) as client:
        print("✅ 已连接，让它动 5 秒——看是哪个玩具动！")
        await client.write_gatt_char(WRITE_UUID, bytes([H, 4, 0, 0, 1, 200, 0xAA]), response=False)
        await asyncio.sleep(5)
        await client.write_gatt_char(WRITE_UUID, bytes([H, 4, 0, 0, 0, 0, 0xAA]), response=False)
        print("⏹ 停止。这个 E2 地址是震动棒还是吮吸款？")

if __name__ == "__main__":
    asyncio.run(main())
