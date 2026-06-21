// 星露谷 AI 伴侣 bot — 轮询 Railway bridge 拿 el 发来的指令，执行后回传结果
// 用法：node bot.js
// 需要游戏已开着（SMAPI 启动），MCP server 会自动子进程启动

import { spawn } from "child_process";

const BRIDGE_URL = process.env.BRIDGE_URL || "https://el-system-production.up.railway.app";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const BRIDGE_PATH = process.env.STARDEW_BRIDGE_PATH ||
  "E:\\steam\\steamapps\\common\\Stardew Valley\\Mods\\StardewMCPBridge\\bridge_data.json";
const ACTION_DIR = process.env.STARDEW_ACTION_DIR ||
  "E:\\steam\\steamapps\\common\\Stardew Valley\\Mods\\StardewMCPBridge\\actions";

// 启动 MCP server 子进程
const server = spawn("node", ["C:\\stardew-mcp\\mcp-server\\build\\index.js"], {
  env: { ...process.env, STARDEW_BRIDGE_PATH: BRIDGE_PATH, STARDEW_ACTION_DIR: ACTION_DIR },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pendingRequests = new Map();
let reqId = 1;
const tools = [];

function sendToServer(msg) {
  server.stdin.write(JSON.stringify(msg) + "\n");
}

function callTool(name, args = {}) {
  return new Promise((resolve) => {
    const id = reqId++;
    pendingRequests.set(id, resolve);
    sendToServer({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  });
}

server.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pendingRequests.has(msg.id)) {
        pendingRequests.get(msg.id)(msg.result);
        pendingRequests.delete(msg.id);
      }
      if (msg.result?.tools) tools.push(...msg.result.tools);
    } catch {}
  }
});

server.stderr.on("data", (d) => process.stderr.write(d));
server.on("exit", (code) => { console.error("MCP server 退出:", code); process.exit(1); });

const headers = (extra = {}) => ({
  "Content-Type": "application/json",
  ...(BRIDGE_SECRET ? { "x-bridge-secret": BRIDGE_SECRET } : {}),
  ...extra,
});

async function postResult(result) {
  try {
    await fetch(`${BRIDGE_URL}/stardew-result`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(result),
    });
  } catch (e) {
    console.error("回传结果失败:", e.message);
  }
}

// 执行 el 发来的指令
async function execute(cmd) {
  const { action, message } = cmd;
  console.log(`▶ 执行指令: ${action}`, message || "");

  try {
    let toolName, toolArgs;

    switch (action) {
      case "spawn":        toolName = "stardew_spawn"; toolArgs = {}; break;
      case "water_all":    toolName = "stardew_water_all"; toolArgs = {}; break;
      case "harvest_all":  toolName = "stardew_harvest_all"; toolArgs = {}; break;
      case "farm":         toolName = "stardew_farm"; toolArgs = {}; break;
      case "mine":         toolName = "stardew_mine"; toolArgs = {}; break;
      case "fish":         toolName = "stardew_fish"; toolArgs = {}; break;
      case "follow":       toolName = "stardew_follow"; toolArgs = {}; break;
      case "get_state":    toolName = "stardew_get_state"; toolArgs = {}; break;
      case "custom":
        // 自定义指令：让游戏内发一条 chat 消息
        toolName = "stardew_chat";
        toolArgs = { message: message || "你好" };
        break;
      default:
        await postResult({ ok: false, action, error: `未知 action: ${action}` });
        return;
    }

    const result = await callTool(toolName, toolArgs);
    console.log("✅ 执行完成:", JSON.stringify(result).slice(0, 200));
    await postResult({ ok: true, action, result });
  } catch (e) {
    console.error("执行失败:", e.message);
    await postResult({ ok: false, action, error: e.message });
  }
}

// 初始化 MCP server
async function init() {
  sendToServer({ jsonrpc: "2.0", id: reqId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stardew-bot", version: "1.0" } } });
  await new Promise(r => setTimeout(r, 500));
  sendToServer({ jsonrpc: "2.0", id: reqId++, method: "tools/list", params: {} });
  await new Promise(r => setTimeout(r, 500));
  console.log("✅ MCP server 连接成功，工具数量:", tools.length);
}

// 轮询循环
async function poll() {
  try {
    const res = await fetch(`${BRIDGE_URL}/stardew-poll`, {
      headers: headers(),
    });
    if (res.ok) {
      const cmd = await res.json();
      if (cmd && cmd.action) {
        await execute(cmd);
      }
    }
  } catch (e) {
    console.error("轮询失败:", e.message);
  }
  setTimeout(poll, 2000); // 每2秒轮询一次
}

console.log("🌾 星露谷 bot 启动中...");
console.log("Bridge:", BRIDGE_URL);
init().then(() => {
  console.log("🔄 开始轮询 Railway bridge...");
  poll();
});
