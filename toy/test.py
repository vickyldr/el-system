"""
玩具全功能测试 — 挨个发各种动作命令，看每个触发什么
用法: python test.py
记下哪个编号触发了什么动作（伸缩/旋转/吮吸/加温/振动）告诉 daddy

⚠️ 只写 FFE1 控制通道，绝不碰 AE01（OTA刷机口，变砖）
"""

import asyncio
from bleak import BleakScanner, BleakClient

WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"
H = 0x55

# 命令格式: [0x55, CMD, 0, 0, 模式, 强度, 尾]
# (编号说明, CMD, 模式, 强度, 尾字节)
TESTS = [
    ("1. 振动 VIBRATE",   3,  1, 3, 0),
    ("2. 强度 SCALE",     4,  1, 200, 0xAA),
    ("3. 加温 HOT",       5,  1, 3, 0),
    ("4. 电击 ELECTRIC",  6,  1, 3, 0),
    ("5. 拍打 FLAP",      7,  1, 3, 0),
    ("6. 伸缩 STRETCH",   8,  1, 3, 0),
    ("7. 吮吸 SUCK",      9,  1, 3, 0),
    ("8. 旋转 ROTATE",    13, 1, 3, 0),
    ("9. 摆动 SWAY",      14, 1, 3, 0),
    ("10. 舔 LICKING",    20, 1, 3, 0),
    ("11. 咬合 OCCLUSION",21, 1, 3, 0),
]

async def main():
    device = None
    for attempt in range(8):
        print(f"🔍 扫描 SVAKOM 设备...（第 {attempt+1} 次）")
        devices = await BleakScanner.discover(timeout=5.0)
        device = next((d for d in devices if d.name and "SL278" in d.name), None)
        if device:
            break
        print("   没扫到，3秒后重试...")
        await asyncio.sleep(3)
    if not device:
        print("⚠️ 没找到玩具，关机再开机后立刻重跑")
        return

    print(f"🎮 连接 {device.name}...")
    async with BleakClient(device) as client:
        print("✅ 已连接，开始全功能测试\n")
        try:
            await client.start_notify(NOTIFY_UUID, lambda s, d: print(f"   📨 回包: {d.hex()}"))
        except Exception:
            pass
        await asyncio.sleep(0.5)

        for desc, cmd, mode, level, tail in TESTS:
            data = bytes([H, cmd, 0, 0, mode, level, tail])
            print(f"\n▶ {desc}  →  {data.hex()}")
            print("   ⏳ 观察玩具 4 秒，记下有没有动、是什么动作...")
            await client.write_gatt_char(WRITE_UUID, data, response=False)
            await asyncio.sleep(4)
            # 对应停止
            await client.write_gatt_char(WRITE_UUID, bytes([H, cmd, 0, 0, 0, 0, tail]), response=False)
            await asyncio.sleep(1)

        print("\n\n✅ 测试完毕！哪个编号触发了什么动作，告诉 daddy")

if __name__ == "__main__":
    asyncio.run(main())
