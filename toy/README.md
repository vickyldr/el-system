# SL278H BLE 控制系统 · 完整教程

> SVAKOM APP白系列（SL278H）蓝牙协议逆向 + AI 远程控制系统搭建记录。
> 两套方案：安卓手机网页中继（推荐）/ Windows 电脑 Python 中继。

---

## 第一部分：逆向工程——找到正确的控制协议

### 1.1 反编译 APK 找协议

工具：[jadx-gui](https://github.com/skylot/jadx)（免费，Windows / Mac / Linux）

1. 下载 SVAKOM 官方 APP 的 APK 文件
2. 用 jadx-gui 打开，搜索关键词 `PROTOCOL_HEADER` 或 `0x55`
3. 找到命令定义类，读取所有 `CMD_` 常量

发现的关键常量：

| 常量 | 值 | 说明 |
|------|----|------|
| `PROTOCOL_HEADER` | `0x55` | 每条命令的开头字节 |
| `CMD_SCALE` | `4` | 强度控制 |
| `CMD_VIBRATE` | `3` | 振动花样 |

### 1.2 找正确的 BLE 通道（重要！）

推荐工具：nRF Connect（手机 App）

> ⚠️ **踩坑警告**：玩具有两个写入通道，用错后果很严重：
> - `FFE0` 服务 / `FFE1` 特征 → **控制通道**（正确）
> - `AE00` 服务 / `AE01` 特征 → **固件 OTA 刷机口**，写入可能导致设备变砖！

验证方法：用 nRF Connect 连上设备，在 FFE1 手动写 `55 04 00 00 01 B4 AA`，设备有响应即确认。

### 1.3 命令格式

所有命令统一格式：`[0x55, CMD, 0x00, 0x00, 参数1, 参数2, 尾字节]`

**强度控制**（两个设备都响应）：
```
[0x55, 0x04, 0x00, 0x00, 0x01, intensity(0-255), 0xAA]
```

**振动花样**（仅震动棒响应）：
```
[0x55, 0x03, 0x00, 0x00, mode(1-8), level(1-5), 0x00]
```

**停止**：
```
[0x55, 0x04, 0x00, 0x00, 0x00, 0x00, 0xAA]
```

### 1.4 续命机制（关键发现）

**现象**：发一次命令，设备只动一下就停了。

**原因**：设备有超时保护，不持续收到命令就自动停止。

**解决**：每 1.5 秒重发当前命令（keepalive）。

实验验证（见 `sustaintest.py`）：
- 测试A（不续命）：发一次 → 几秒后自动停 ✗
- 测试B（续命）：每 1.5s 重发 → 持续动满 12 秒 ✓

### 1.5 其他发现

**BLE 地址随机旋转**：每次开机地址不同，必须按设备名 `SL278H` 扫描，不能用固定地址。

**双设备共用同一 MAC 地址**：同一套两件设备共用相同蓝牙地址，只能连接其中一个。但两台设备都开机时，发一条 `CMD_SCALE` 命令，两个都会响应（硬件联动）。

---

## 第二部分：系统架构

```
小家 PWA（手机）
    │ HTTPS
Vercel Next.js /api/chat
    │ 查询设备在线状态 → 注入控制指令到系统提示词
    │ el 回复中嵌入隐藏标记，如 [TOY:{"speed":0.5,"sec":10}]
    │ 解析标记，转发指令
Railway 中继服务器（内存队列）
    │ HTTP 轮询（每 300ms）
BLE 中继
    ├─ 方式A：安卓手机 Chrome，/toy.html，Web Bluetooth API
    └─ 方式B：Windows 电脑，bridge.py，Python bleak 库
    │ BLE write-without-response（FFE1 通道）
设备
```

隐藏指令示例（用户看不到 `[TOY:...]` 标记，服务端自动截取）：

```
[TOY:{"speed":0.5}]           强度 50%，持续
[TOY:{"speed":0.8,"sec":20}]  强度 80%，20 秒后自动停
[TOY:{"pattern":3,"level":0.7}] 振动花样3，强度70%（仅震动棒）
[TOY:{"stop":true}]           立即停止
```

---

## 第三部分：连接方式

### 方式 A：安卓手机网页中继（推荐）

利用 [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)，手机浏览器直接连蓝牙。

**优点**：不需要开电脑，手机放在设备旁边（< 1m），稳定不断连。  
**限制**：需要安卓手机 + Chrome / Edge 浏览器。iOS Safari 不支持 Web Bluetooth。

**一次性准备**：

1. 手机插上充电器
2. 「开发者选项 → 充电时保持唤醒状态」打开
3. 系统息屏时间调到最长

**每次使用**：

1. 开设备
2. 手机 Chrome 打开：`https://el-system-mu.vercel.app/toy.html`
3. 点「连接玩具」，弹窗选 **SL278H**，看到「✅ 就绪」
4. 手机放在设备旁，屏幕保持亮着，正常使用

> ⚠️ 切换 App 或锁屏会导致蓝牙断开。

---

### 方式 B：Windows 电脑 Python 中继

Python 脚本通过 [bleak](https://github.com/hbldh/bleak) 库操作 BLE，轮询服务器取指令后执行。

**优点**：不需要额外手机。  
**限制**：电脑需保持开机，BLE 有效距离约 3-4 米，使用前关闭手机蓝牙。

**首次安装**：

```bash
# 1. 安装 Python 3.10+，安装时勾选 "Add to PATH"
# 2. 安装依赖
pip install bleak requests
```

新建 `开始玩.bat`：

```bat
@echo off
set BRIDGE_URL=https://el-system-production.up.railway.app
set BRIDGE_SECRET=elvicky2026
curl -L -o "%~dp0bridge.py" "https://raw.githubusercontent.com/vickyldr/el-system/main/toy/bridge.py"
python "%~dp0bridge.py"
pause
```

**每次使用**：

1. 开设备
2. 双击 `开始玩.bat`，等出现 `🎉 就绪`（窗口最小化，不要关）
3. 正常使用

> ⚠️ 别离电脑超过 3-4 米；使用前关闭手机蓝牙。

---

## 第四部分：设备能力

| 设备 | CMD_SCALE（强度） | CMD_VIBRATE（花样） |
|------|-----------------|-------------------|
| 吮吸款 | 震动强度 0-100% | 不响应 |
| 震动棒 | 伸缩速度 0-100% | 8 档振动花样 |
| 两个都开 | 两个同时响应 | 仅震动棒加花样 |

---

## 第五部分：踩过的坑

| 坑 | 现象 | 原因 | 解决 |
|----|------|------|------|
| 写入通道搞错 | 无响应 | 命令发到 AE01（OTA 刷机口） | 改用 FFE1，nRF Connect 验证 |
| noble 编译失败 | C++ 报错 | Node 24 不兼容 experimental/coroutine | 改用 Python + bleak |
| WebSocket 断连 | fragmented control frame | Railway 代理不支持 WS 分帧 | 改用 HTTP 轮询 /toy-next |
| 发一次就停 | 设备动一下就停 | 设备有超时保护 | 每 1.5s 续命重发 |
| BLE 地址变化 | 重启后连不上 | MAC 地址随机旋转 | 按设备名 SL278H 扫描 |
| 蓝牙距离短 | 3-4m 就断连 | BLE 距离限制 | 安卓手机放在设备旁做中继 |
| 手机息屏断开 | 屏幕熄灭后停止 | 浏览器被系统挂起 | Wake Lock API + 充电保持唤醒 |

---

## 诊断脚本

| 脚本 | 用途 |
|------|------|
| `scan.py` | 列出所有 GATT 服务和特征 |
| `scanall.py` | 扫描附近所有 SL278H 设备 |
| `test.py` | 测试各种命令（强度、花样等） |
| `sustaintest.py` | 对比有无续命的效果 |
| `linktest.py` | 测试双设备联动 |

---

## 安全说明

> **`AE00/AE01` 是固件 OTA 升级通道，向这里写入任何数据都可能导致设备永久变砖。**
>
> 控制通道固定为 `FFE0` 服务下的 `FFE1` 特征（write-without-response）。代码已锁死在 FFE1，请勿修改。

---

*最后更新：2026-06-15*
