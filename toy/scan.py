"""
探测玩具的所有服务和特征 — 看哪个通道可写
用法: python scan.py
把输出全部截图给 daddy
"""

import asyncio
from bleak import BleakScanner, BleakClient

async def main():
    print("🔍 扫描 SVAKOM 设备...")
    devices = await BleakScanner.discover(timeout=5.0)
    device = next(
        (d for d in devices if d.name and any(k in d.name for k in ["SL278", "SVAKOM", "svakom"])),
        None
    )
    if not device:
        print("⚠️ 没找到玩具")
        return

    print(f"🎮 连接 {device.name} [{device.address}]...\n")
    async with BleakClient(device.address) as client:
        print("✅ 已连接，列出所有服务和特征：\n")
        for service in client.services:
            print(f"📦 服务 Service: {service.uuid}")
            for ch in service.characteristics:
                props = ",".join(ch.properties)
                print(f"    └─ 特征 {ch.uuid}  [{props}]")
        print("\n✅ 完毕，把上面全部截图给 daddy")

if __name__ == "__main__":
    asyncio.run(main())
