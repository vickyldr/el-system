"""
el-toy-bridge — Python BLE 控制 SVAKOM 玩具（双设备，按地址前缀匹配）
依赖: pip install bleak aiohttp

用法:
  set BRIDGE_URL=https://你的railway地址
  set BRIDGE_SECRET=你的密钥
  python bridge.py

⚠️ 控制通道是 FFE0/FFE1。绝对不要写 AE00/AE01——那是 OTA 固件升级通道，写错会变砖！
⚠️ 玩具用随机轮换蓝牙地址，每次开机后缀都变，所以按"前缀"匹配，不写死完整地址。
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

# 控制通道（FFE0 服务下的 FFE1 写入特征）。绝不碰 AE00/AE01（OTA刷机口，变砖）
WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"

# 按地址前缀区分两个玩具（地址后缀会随机轮换）。控反了就把这两行前缀对调。
ROD_PREFIX = "FF:25:12"    # 震动棒（speed 控它）
SUCK_PREFIX = "E2:6F:5E"   # 吮吸款（suck 控它）

H = 0x55

def cmd_scale(v):
    # 连续强度命令：[0x55, 4, 0, 0, 1, 强度0-255, 0xAA]
    return bytes([H, 4, 0, 0, 1, max(0, min(255, v)), 0xAA])

def cmd_scale_stop():
    return bytes([H, 4, 0, 0, 0, 0, 0xAA])

cmd_queue = asyncio.Queue()
clients = {}        # role("rod"/"suck") -> BleakClient
found = {}          # role -> BLEDevice
scan_lock = asyncio.Lock()

def role_of(addr):
    a = (addr or "").upper()
    if a.startswith(ROD_PREFIX.upper()):
        return "rod"
    if a.startswith(SUCK_PREFIX.upper()):
        return "suck"
    return None

async def write_role(role, buf):
    client = clients.get(role)
    if client and client.is_connected:
        try:
            await client.write_gatt_char(WRITE_UUID, buf, response=False)
            return True
        except Exception as e:
            print(f"写入失败 [{role}]: {e}")
    return False

async def exec_cmd(c: dict):
    if c.get("stop"):
        await write_role("rod", cmd_scale_stop())
        await write_role("suck", cmd_scale_stop())
        print("⏹ 全部停止")
        return
    if "speed" in c:
        ok = await write_role("rod", cmd_scale(int(c["speed"] * 255)))
        print(f"📳 震动棒 {int(c['speed']*100)}% {'✓' if ok else '(未连接)'}")
    if "suck" in c:
        ok = await write_role("suck", cmd_scale(int(c["suck"] * 255)))
        print(f"💨 吮吸 {int(c['suck']*100)}% {'✓' if ok else '(未连接)'}")

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
                            print("✅ el-bridge 已连接")
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

async def scanner_loop():
    """全量扫描，按前缀认出两个玩具，存进 found"""
    while True:
        need = [r for r in ("rod", "suck") if r not in clients]
        if need:
            async with scan_lock:
                try:
                    print(f"🔍 扫描中...（还需连：{need}）")
                    devices = await BleakScanner.discover(timeout=6.0)
                    sva = [d for d in devices if d.name and "SL278" in d.name]
                    for d in sva:
                        r = role_of(d.address)
                        tag = {"rod": "震动棒", "suck": "吮吸款"}.get(r, "未知")
                        print(f"   {d.name}[{d.address}] → {tag}")
                        if r and r not in clients:
                            found[r] = d
                except Exception as e:
                    print(f"扫描出错: {e}")
        await asyncio.sleep(2)

async def device_loop(role, label):
    while True:
        if role in clients:
            await asyncio.sleep(2)
            continue
        dev = found.get(role)
        if not dev:
            await asyncio.sleep(2)
            continue
        try:
            print(f"🎮 连接 {label} [{dev.address}]...")
            async with BleakClient(dev) as client:
                clients[role] = client
                try:
                    await client.start_notify(NOTIFY_UUID, lambda s, d: None)
                except Exception:
                    pass
                print(f"✅ {label} 就绪")
                while client.is_connected:
                    await asyncio.sleep(1.0)
        except Exception as e:
            print(f"{label} 连接断开: {e}")
        finally:
            clients.pop(role, None)
            found.pop(role, None)
        print(f"🔄 {label} 重连中...")
        await asyncio.sleep(3)

async def command_loop():
    while True:
        c = await cmd_queue.get()
        await exec_cmd(c)

async def main():
    print(f"目标设备（按前缀匹配）：\n  震动棒 {ROD_PREFIX}:xx:xx:xx\n  吮吸款 {SUCK_PREFIX}:xx:xx:xx")
    await asyncio.gather(
        bridge_loop(),
        scanner_loop(),
        device_loop("rod", "震动棒"),
        device_loop("suck", "吮吸款"),
        command_loop(),
    )

if __name__ == "__main__":
    asyncio.run(main())
