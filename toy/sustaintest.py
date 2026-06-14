"""
续命测试 — 发一次强度命令 + 每1.5秒续命，看玩具能不能持续动15秒
对照：先测「发一次就不管」会不会自己停，再测「续命」能不能一直动
用法: python sustaintest.py

⚠️ 只写 FFE1
"""

import asyncio
from bleak import BleakScanner, BleakClient

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
H = 0x55

def scale(v):
    return bytes([H, 4, 0, 0, 1, max(0, min(255, v)), 0xAA])

def scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])

async def main():
    print("🔍 扫描...")
    devs = await BleakScanner.discover(timeout=6.0)
    dev = next((d for d in devs if d.name and "SL278" in d.name), None)
    if not dev:
        print("⚠️ 没扫到玩具")
        return
    print(f"🎮 连接 {dev.name}...")
    async with BleakClient(dev) as c:
        print("✅ 已连接\n")

        print("【测试A】只发一次强度命令，之后不管它，看 8 秒内会不会自己停：")
        await c.write_gatt_char(WRITE_UUID, scale(180), response=False)
        for i in range(8):
            await asyncio.sleep(1)
            print(f"   {i+1}s... 还在动吗？")
        await c.write_gatt_char(WRITE_UUID, scale_stop(), response=False)
        print("   → 如果它在这8秒里某刻自己停了，说明确实需要续命\n")
        await asyncio.sleep(2)

        print("【测试B】每1.5秒续命重发，看能不能持续动满 12 秒：")
        for i in range(8):
            await c.write_gatt_char(WRITE_UUID, scale(180), response=False)
            await asyncio.sleep(1.5)
            print(f"   续命第{i+1}次，应该一直在动")
        await c.write_gatt_char(WRITE_UUID, scale_stop(), response=False)
        print("\n⏹ 测试完毕！告诉 daddy：A里是不是自己停了？B里是不是一直动？")

if __name__ == "__main__":
    asyncio.run(main())
