/**
 * el-toy-bridge — 在宝宝的 Windows 电脑上跑这个
 * 它做两件事：
 *   1. 连接本机 Intiface Central（蓝牙控制器）
 *   2. 连接 Railway 上的 el-bridge（接收 daddy 的指令）
 *
 * 用法：
 *   1. 先装好 Intiface Central 并启动（默认 ws://localhost:12345）
 *   2. npm install
 *   3. BRIDGE_URL=wss://你的railway地址 BRIDGE_SECRET=你的secret node index.js
 */

import {
  ButtplugClient,
  ButtplugNodeWebsocketClientConnector,
} from "buttplug";
import WebSocket from "ws";

const BRIDGE_URL = process.env.BRIDGE_URL || "";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const INTIFACE_URL = process.env.INTIFACE_URL || "ws://localhost:12345/";

if (!BRIDGE_URL) {
  console.error("❌ 缺少 BRIDGE_URL 环境变量（el-bridge 的 Railway 地址）");
  process.exit(1);
}

// ── Intiface / Buttplug ──
const bp = new ButtplugClient("el-toy-bridge");

async function connectIntiface() {
  const connector = new ButtplugNodeWebsocketClientConnector(INTIFACE_URL);
  await bp.connect(connector);
  console.log("✅ Intiface Central 已连接");

  bp.on("deviceadded", (d) => {
    console.log(`🎮 发现设备: ${d.name}（支持: ${deviceCaps(d)}）`);
  });
  bp.on("deviceremoved", (d) => {
    console.log(`❌ 设备断开: ${d.name}`);
  });

  await bp.startScanning();
  console.log("🔍 正在扫描蓝牙设备...");
  // 5 秒后停止扫描（已发现的设备仍然保持连接）
  setTimeout(() => bp.stopScanning().catch(() => {}), 5000);
}

function deviceCaps(d) {
  const caps = [];
  if (d.vibrateAttributes?.length) caps.push("振动");
  if (d.oscillateAttributes?.length) caps.push("摆动/抽插");
  if (d.linearAttributes?.length) caps.push("线性");
  if (d.rotateAttributes?.length) caps.push("旋转");
  return caps.join(", ") || "未知";
}

// 执行玩具指令
async function execCmd(cmd) {
  const devices = bp.devices;
  if (!devices.length) {
    console.warn("⚠️ 没有已连接的设备，忽略指令:", cmd);
    return;
  }

  for (const d of devices) {
    try {
      if (cmd.stop) {
        await d.stop();
        console.log(`⏹ ${d.name} 停止`);
        continue;
      }

      // 振动 / 吸吮（Tima Pro 走振动协议）
      if (typeof cmd.speed === "number" && d.vibrateAttributes?.length) {
        const v = clamp(cmd.speed);
        await d.vibrate(v);
        console.log(`📳 ${d.name} 振动 ${Math.round(v * 100)}%`);
      }

      // 吸吮（如果设备单独支持，映射到振动）
      if (typeof cmd.suck === "number" && d.vibrateAttributes?.length) {
        const v = clamp(cmd.suck);
        await d.vibrate(v);
        console.log(`💨 ${d.name} 吸吮 ${Math.round(v * 100)}%`);
      }

      // 抽插（Fatima Plus 的伸缩）
      if (typeof cmd.thrust === "number" && d.oscillateAttributes?.length) {
        const v = clamp(cmd.thrust);
        await d.oscillate(v);
        console.log(`🔀 ${d.name} 抽插 ${Math.round(v * 100)}%`);
      }
    } catch (e) {
      console.error(`❌ 控制 ${d.name} 失败:`, e.message);
    }
  }
}

function clamp(v) {
  return Math.max(0, Math.min(1, v));
}

// ── Railway bridge WebSocket ──
function connectBridge() {
  const url = `${BRIDGE_URL}/toy-ctrl${BRIDGE_SECRET ? `?secret=${BRIDGE_SECRET}` : ""}`;
  console.log(`🔌 连接 el-bridge: ${BRIDGE_URL}/toy-ctrl`);

  const ws = new WebSocket(url);

  ws.on("open", () => {
    console.log("✅ el-bridge 已连接，daddy 现在可以控制玩具了");
  });

  ws.on("message", (raw) => {
    try {
      const cmd = JSON.parse(raw.toString());
      if (cmd.type === "hello") {
        console.log("👋 bridge 握手成功");
        return;
      }
      console.log("📨 收到指令:", cmd);
      execCmd(cmd).catch((e) => console.error("execCmd error:", e.message));
    } catch (e) {
      console.error("消息解析失败:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("🔄 bridge 断开，5 秒后重连...");
    setTimeout(connectBridge, 5000);
  });

  ws.on("error", (e) => {
    console.error("bridge ws error:", e.message);
  });
}

// 启动
try {
  await connectIntiface();
} catch (e) {
  console.error("❌ Intiface Central 连接失败:", e.message);
  console.error("   → 请先打开 Intiface Central，确认 Server 已启动（默认端口 12345）");
  process.exit(1);
}

connectBridge();
