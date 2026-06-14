"""
联动测试 — 两个玩具都开机，脚本连上其中一个，发强度命令
看是「只有一个动」还是「两个都动」
用法: python linktest.py

⚠️ 只写 FFE1，绝不碰 AE01（OTA口，变砖）
"""

import asyncio
from bleak import BleakScanner, BleakClient

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
H = 0x55

async def main():
    print("🔍 扫描（两个玩具都要开着）...")
    devices = await BleakScanner.discover(timeout=6.0)
    sva = [d for d in devices if d.name and "SL278" in d.name]
    print(f"扫到 {len(sva)} 个 SVAKOM 设备：")
    for d in sva:
        print(f"   {d.name} [{d.address}]")
    if not sva:
        print("⚠️ 没扫到，确认玩具开着")
        return

    device = sva[0]
    print(f"\n🎮 连接第一个 [{device.address}]...")
    async with BleakClient(device) as client:
        print("✅ 已连接\n")
        print("▶ 发强度命令 5 秒——看是【一个动】还是【两个都动】！")
        await client.write_gatt_char(WRITE_UUID, bytes([H, 4, 0, 0, 1, 200, 0xAA]), response=False)
        await asyncio.sleep(5)
        await client.write_gatt_char(WRITE_UUID, bytes([H, 4, 0, 0, 0, 0, 0xAA]), response=False)
        print("⏹ 停。\n")
        print("再来一次振动花样命令 5 秒——同样看几个动")
        await asyncio.sleep(1)
        await client.write_gatt_char(WRITE_UUID, bytes([H, 3, 0, 0, 1, 3, 0]), response=False)
        await asyncio.sleep(5)
        await client.write_gatt_char(WRITE_UUID, bytes([H, 3, 0, 0, 0, 0, 0]), response=False)
        print("⏹ 测试完毕！告诉 daddy：强度命令几个动？振动命令几个动？")

if __name__ == "__main__":
    asyncio.run(main())
