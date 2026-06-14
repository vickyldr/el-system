"""
列出附近所有 SVAKOM 设备及地址 — 确认两个玩具地址是否不同
用法: 两个玩具都开机，python scanall.py
把输出截图给 daddy
"""

import asyncio
from bleak import BleakScanner

async def main():
    print("🔍 扫描 8 秒，找出所有 SVAKOM 设备...\n")
    devices = await BleakScanner.discover(timeout=8.0)
    found = []
    for d in devices:
        name = d.name or ""
        if any(k in name for k in ["SL278", "SVAKOM", "svakom"]):
            found.append(d)
            print(f"🎮 {name}  地址: {d.address}")
    print(f"\n共找到 {len(found)} 个 SVAKOM 设备")
    if len(found) < 2:
        print("⚠️ 只看到 1 个——要么另一个没开/没广播，要么两个共用地址")

if __name__ == "__main__":
    asyncio.run(main())
