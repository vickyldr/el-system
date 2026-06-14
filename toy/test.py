"""
玩具命令测试 — 连上后挨个发各种命令，看哪个让玩具动
用法: python test.py
看到玩具动了，记住屏幕上对应的编号告诉 daddy
"""

import asyncio
from bleak import BleakScanner, BleakClient

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
H = 0x55

# 每个测试: (编号说明, 字节)
TESTS = [
    ("1. 振动 CMD_VIBRATE mode=1 强度=5", bytes([H, 3, 0, 0, 1, 5, 0])),
    ("2. 振动 CMD_VIBRATE mode=5 强度=5", bytes([H, 3, 0, 0, 5, 5, 0])),
    ("3. 振动 强度直填 i=128", bytes([H, 3, 0, 0, 128, 0, 0])),
    ("4. 强度 CMD_SCALE=4 满", bytes([H, 4, 0, 0, 1, 200, 0xAA])),
    ("5. 吸吮 CMD_SUCK=9 强", bytes([H, 9, 0, 0, 1, 200, 0xAA])),
    ("6. 吸吮 CMD_SUCK mode=3", bytes([H, 9, 0, 0, 3, 5, 0])),
    ("7. 抽插 CMD_STRETCH=8 mode=1", bytes([H, 8, 0, 0, 1, 5, 0])),
    ("8. 舔 CMD_LICKING=20 mode=1", bytes([H, 20, 0, 0, 1, 5, 0])),
    ("9. 吮 CMD_OCCLUSION=21 mode=1", bytes([H, 21, 0, 0, 1, 5, 0])),
    ("10. 拍打 CMD_FLAP=7 mode=1", bytes([H, 7, 0, 0, 1, 5, 0])),
]

# 各命令对应的停止
STOPS = {
    3: bytes([H, 3, 0, 0, 0, 0, 0]),
    4: bytes([H, 4, 0, 0, 0, 0, 0xAA]),
    9: bytes([H, 9, 0, 0, 0, 0, 0xAA]),
    8: bytes([H, 8, 0, 0, 0, 0, 0]),
    20: bytes([H, 20, 0, 0, 0, 0, 0]),
    21: bytes([H, 21, 0, 0, 0, 0, 0]),
    7: bytes([H, 7, 0, 0, 0, 0, 0]),
}

async def main():
    device = None
    for attempt in range(8):
        print(f"🔍 扫描 SVAKOM 设备...（第 {attempt+1} 次）")
        devices = await BleakScanner.discover(timeout=5.0)
        device = next(
            (d for d in devices if d.name and any(k in d.name for k in ["SL278", "SVAKOM", "svakom"])),
            None
        )
        if device:
            break
        print("   没扫到，3秒后重试...")
        await asyncio.sleep(3)
    if not device:
        print("⚠️ 多次没找到玩具，把它关机再开机后立刻重跑")
        return

    print(f"🎮 连接 {device.name}...")
    async with BleakClient(device.address) as client:
        print("✅ 已连接，开始测试\n")
        await client.start_notify(NOTIFY_UUID, lambda s, d: print(f"   📨 回包: {d.hex()}"))
        await asyncio.sleep(0.5)

        for desc, cmd in TESTS:
            print(f"\n▶ 测试 {desc}")
            print(f"   发送: {cmd.hex()}")
            await client.write_gatt_char(WRITE_UUID, cmd, response=False)
            print("   ⏳ 观察玩具 4 秒...")
            await asyncio.sleep(4)
            # 停止
            stop = STOPS.get(cmd[1], bytes([H, cmd[1], 0, 0, 0, 0, 0]))
            await client.write_gatt_char(WRITE_UUID, stop, response=False)
            await asyncio.sleep(1)

        print("\n\n✅ 测试完毕！哪几个编号让玩具动了，告诉 daddy")

if __name__ == "__main__":
    asyncio.run(main())
