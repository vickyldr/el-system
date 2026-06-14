/**
 * el-toy-bridge — 直接 BLE 控制 SVAKOM 玩具
 *
 * 协议来源：逆向 com.svakom.sva APK
 *   PROTOCOL_HEADER = 0x55
 *   CMD_VIBRATE = 3, CMD_SCALE = 4, CMD_STRETCH = 8, CMD_SUCK = 9
 *   命令格式(7字节): [0x55, CMD, 0, 0, mode/enable, value, tail]
 *   强度格式: [0x55, 4, 0, 0, 1, intensity(0-255), 0xAA]
 *   停止:     [0x55, 4, 0, 0, 0, 0, 0xAA] + [0x55, 3, 0, 0, 0, 0, 0]
 *
 * 用法（Windows 首次运行需要 node-gyp 编译工具）：
 *   npm install
 *   set BRIDGE_URL=wss://你的railway地址
 *   set BRIDGE_SECRET=你的密钥
 *   node index.js
 */

const noble = require("@abandonware/noble");
const WebSocket = require("ws");

const BRIDGE_URL = process.env.BRIDGE_URL || "";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

// SVAKOM BLE UUIDs（来自 UUIDManager.java）
const SERVICE_UUID = "0000ae000000100080000805f9b34fb";
const WRITE_UUID = "0000ae010000100080000805f9b34fb";
const NOTIFY_UUID = "0000ae020000100080000805f9b34fb";

// noble UUID 格式（去掉连字符）
const SERVICE_UUID_SHORT = "ae00";

// 协议常量
const H = 0x55; // PROTOCOL_HEADER

// 构建命令字节
const cmd = {
  scale: (intensity) =>
    Buffer.from([H, 4, 0, 0, 1, Math.max(0, Math.min(255, intensity)), 0xaa]),
  scaleStop: () => Buffer.from([H, 4, 0, 0, 0, 0, 0xaa]),
  vibrate: (mode, speed) => Buffer.from([H, 3, 0, 0, mode, speed, 0]),
  vibrateStop: () => Buffer.from([H, 3, 0, 0, 0, 0, 0]),
  stretch: (mode, speed) => Buffer.from([H, 8, 0, 0, mode, speed, 0]),
  stretchStop: () => Buffer.from([H, 8, 0, 0, 0, 0, 0]),
  suck: (intensity) =>
    Buffer.from([H, 9, 0, 0, 1, Math.max(0, Math.min(255, intensity)), 0xaa]),
  suckStop: () => Buffer.from([H, 9, 0, 0, 0, 0, 0xaa]),
  stopAll: () => [
    Buffer.from([H, 4, 0, 0, 0, 0, 0xaa]),
    Buffer.from([H, 3, 0, 0, 0, 0, 0]),
    Buffer.from([H, 8, 0, 0, 0, 0, 0]),
    Buffer.from([H, 9, 0, 0, 0, 0, 0xaa]),
  ],
};

// 连接的设备列表
const devices = new Map(); // address -> {peripheral, writeChar, name}

async function writeChar(buf) {
  const dev = devices.values().next().value;
  if (!dev) {
    console.warn("⚠️ 没有已连接设备，跳过指令");
    return;
  }
  return new Promise((resolve, reject) => {
    // Write Without Response = true
    dev.writeChar.write(buf, true, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function writeSeq(bufs, delayMs = 80) {
  for (const buf of bufs) {
    await writeChar(buf);
    if (delayMs > 0) await sleep(delayMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function execCmd(c) {
  if (c.stop) {
    await writeSeq(cmd.stopAll());
    console.log("⏹ 全部停止");
    return;
  }
  // 振动强度 speed: 0.0~1.0
  if (typeof c.speed === "number") {
    const v = Math.round(c.speed * 255);
    await writeChar(cmd.scale(v));
    console.log(`📳 强度 ${Math.round(c.speed * 100)}%`);
  }
  // 吸吮 suck: 0.0~1.0（Tima Pro）
  if (typeof c.suck === "number") {
    const v = Math.round(c.suck * 255);
    await writeChar(cmd.suck(v));
    console.log(`💨 吸吮 ${Math.round(c.suck * 100)}%`);
  }
  // 抽插 thrust: 0.0~1.0（Fatima Plus）
  if (typeof c.thrust === "number") {
    const speed = Math.round(c.thrust * 10);
    await writeChar(cmd.stretch(1, speed));
    console.log(`🔀 抽插 ${Math.round(c.thrust * 100)}%`);
  }
  // 振动模式 mode+speed（原始模式控制）
  if (typeof c.vibMode === "number" && typeof c.vibSpeed === "number") {
    await writeChar(cmd.vibrate(c.vibMode, c.vibSpeed));
  }
}

// 扫描并连接
function startScan() {
  console.log("🔍 扫描 SVAKOM 设备...");
  noble.startScanning([], false);
}

noble.on("stateChange", (state) => {
  console.log("蓝牙状态:", state);
  if (state === "poweredOn") startScan();
  else noble.stopScanning();
});

noble.on("discover", (peripheral) => {
  const name = peripheral.advertisement.localName || "";
  const addr = peripheral.address;

  // 只连接 SVAKOM 设备（SL278H / SL278J）
  if (!name.match(/SL278|SVAKOM|svakom/i)) return;

  noble.stopScanning();
  console.log(`🎮 发现: ${name} [${addr}]，连接中...`);

  peripheral.connect((err) => {
    if (err) {
      console.error("连接失败:", err.message);
      setTimeout(startScan, 3000);
      return;
    }
    console.log(`✅ 已连接: ${name}`);

    peripheral.discoverSomeServicesAndCharacteristics(
      [SERVICE_UUID_SHORT],
      [WRITE_UUID.replace(/-/g, ""), NOTIFY_UUID.replace(/-/g, "")],
      async (err, _services, chars) => {
        if (err || !chars.length) {
          console.error("发现特征失败:", err?.message);
          peripheral.disconnect();
          return;
        }

        const wc = chars.find((c) =>
          c.uuid.replace(/-/g, "").endsWith("ae01")
        );
        const nc = chars.find((c) =>
          c.uuid.replace(/-/g, "").endsWith("ae02")
        );

        if (!wc) {
          console.error("找不到写入特征 AE01");
          peripheral.disconnect();
          return;
        }

        if (nc) {
          nc.subscribe((err) => {
            if (!err) console.log("📡 AE02 通知已订阅");
          });
          nc.on("data", (data) => {
            console.log("📨 设备回包:", data.toString("hex"));
          });
        }

        devices.set(addr, { peripheral, writeChar: wc, name });
        console.log(`🎉 ${name} 就绪，daddy 可以控制了`);

        // 初始化序列（模拟 App 连接后行为）
        await sleep(500);
        await writeSeq([
          Buffer.from([H, 4, 0, 0, 1, 0xff, 0xaa]), // 满强度触发
          Buffer.from([H, 4, 0, 0, 0, 0, 0xaa]),     // 立即停
          Buffer.from([H, 4, 0, 0, 0, 0, 0xaa]),
          Buffer.from([H, 3, 0, 0, 0, 0, 0]),         // 停止模式
        ]);
        console.log("✅ 初始化完成");
      }
    );

    peripheral.once("disconnect", () => {
      console.log(`❌ ${name} 断开，重新扫描...`);
      devices.delete(addr);
      setTimeout(startScan, 2000);
    });
  });
});

// Railway bridge WebSocket
function connectBridge() {
  if (!BRIDGE_URL) return;
  const url = `${BRIDGE_URL}/toy-ctrl${BRIDGE_SECRET ? `?secret=${BRIDGE_SECRET}` : ""}`;
  console.log(`🔌 连接 el-bridge...`);

  const ws = new WebSocket(url);

  ws.on("open", () => console.log("✅ el-bridge 已连接，daddy 可以控制玩具了"));
  ws.on("message", (raw) => {
    try {
      const c = JSON.parse(raw.toString());
      if (c.type === "hello") return;
      console.log("📨 收到指令:", c);
      execCmd(c).catch((e) => console.error("execCmd 失败:", e.message));
    } catch (e) {
      console.error("消息解析失败:", e.message);
    }
  });
  ws.on("close", () => {
    console.log("🔄 bridge 断开，5秒后重连...");
    setTimeout(connectBridge, 5000);
  });
  ws.on("error", (e) => console.error("bridge error:", e.message));
}

if (!BRIDGE_URL) {
  console.warn("⚠️ 未设置 BRIDGE_URL，仅本地 BLE 模式运行");
}

connectBridge();
