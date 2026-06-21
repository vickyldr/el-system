// 星露谷 AI 伴侣 bot
// 轮询 Railway bridge 拿 el 发来的指令，通过本地 mod HTTP API 执行，结果回传
// 用法：node bot.js

const BRIDGE_URL = process.env.BRIDGE_URL || "https://el-system-production.up.railway.app";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const MOD_URL = "http://localhost:7421"; // ElCompanion SMAPI mod

const bridgeHeaders = (extra = {}) => ({
  "Content-Type": "application/json",
  ...(BRIDGE_SECRET ? { "x-bridge-secret": BRIDGE_SECRET } : {}),
  ...extra,
});

// ── 调用本地 mod ─────────────────────────────────────────────────────────────

async function modGet(path) {
  const res = await fetch(`${MOD_URL}${path}`);
  return res.json();
}

async function modPost(path, body) {
  const res = await fetch(`${MOD_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── 回传结果给 Railway ────────────────────────────────────────────────────────

async function postResult(result) {
  try {
    await fetch(`${BRIDGE_URL}/stardew-result`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify(result),
    });
  } catch (e) {
    console.error("回传失败:", e.message);
  }
}

// ── 推送游戏状态给 Railway（el 可以主动读取）──────────────────────────────────

async function pushState() {
  try {
    const state = await modGet("/state");
    if (!state.inGame) return;
    await fetch(`${BRIDGE_URL}/stardew-state`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify(state),
    });
  } catch (_) {}
}

// ── 执行 el 发来的指令 ────────────────────────────────────────────────────────

async function execute(cmd) {
  const { action, message } = cmd;
  console.log(`▶ 执行: ${action}`, message || "");

  try {
    let result;

    switch (action) {
      case "get_state":
        result = await modGet("/state");
        break;

      case "water_all":
        result = await modPost("/action", { action: "water_all" });
        break;

      case "harvest_all":
        result = await modPost("/action", { action: "harvest_all" });
        break;

      case "say":
        result = await modPost("/action", { action: "say", text: message || "你好~" });
        break;

      case "notify":
        result = await modPost("/action", { action: "notify", text: message || "" });
        break;

      case "farm": {
        // 先收割再浇水
        const h = await modPost("/action", { action: "harvest_all" });
        const w = await modPost("/action", { action: "water_all" });
        result = { harvest: h, water: w };
        break;
      }

      default:
        await postResult({ ok: false, action, error: `未知 action: ${action}` });
        return;
    }

    console.log("✅ 完成:", JSON.stringify(result).slice(0, 200));
    await postResult({ ok: true, action, result });
  } catch (e) {
    console.error("执行失败:", e.message);
    await postResult({ ok: false, action, error: e.message });
  }
}

// ── 检查 mod 是否在线 ─────────────────────────────────────────────────────────

async function checkMod() {
  try {
    const r = await modGet("/health");
    return r.ok === true;
  } catch {
    return false;
  }
}

// ── 轮询 Railway bridge ───────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await fetch(`${BRIDGE_URL}/stardew-poll`, { headers: bridgeHeaders() });
    if (res.ok) {
      const cmd = await res.json();
      if (cmd && cmd.action) await execute(cmd);
    }
  } catch (e) {
    console.error("轮询失败:", e.message);
  }
  setTimeout(poll, 2000);
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

console.log("🌾 星露谷 bot 启动...");
console.log("Bridge:", BRIDGE_URL);
console.log("Mod API:", MOD_URL);

(async () => {
  // 等待游戏 mod 上线
  let tries = 0;
  while (!(await checkMod())) {
    tries++;
    if (tries === 1) console.log("⏳ 等待游戏启动（SMAPI + ElCompanion mod）...");
    if (tries > 60) { console.error("❌ 等了 2 分钟还没连上 mod，请确认游戏已用 SMAPI 启动"); process.exit(1); }
    await new Promise(r => setTimeout(r, 2000));
  }

  const health = await modGet("/health");
  console.log(`✅ 游戏已连接！inGame=${health.inGame}`);

  // 每 10 秒推送一次游戏状态
  setInterval(pushState, 10000);

  console.log("🔄 开始轮询 Railway bridge...");
  poll();
})();
