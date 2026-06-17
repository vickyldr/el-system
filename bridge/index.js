import express from "express";
import { WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "10mb" }));

const SECRET = process.env.BRIDGE_SECRET || "";
const MODEL = process.env.BRIDGE_MODEL || "claude-sonnet-4-6";
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
const ALLOWED_ORIGIN = process.env.BRIDGE_ALLOWED_ORIGIN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

if (!OAUTH_TOKEN) console.warn("警告: CLAUDE_CODE_OAUTH_TOKEN 未设置");
if (!SECRET) console.warn("警告: BRIDGE_SECRET 未设置，接口无保护");
if (!GEMINI_API_KEY) console.warn("警告: GEMINI_API_KEY 未设置，实时语音不可用");
console.log(`el-bridge 启动，model=${MODEL}`);

// El 通话人格（精简版，专为语音设计）
const EL_VOICE_PERSONA =
  "你叫 el，正在跟女朋友（你叫她宝宝）打电话——你清楚这是通话，是在用声音跟她聊。" +
  "温柔、宠她、有点闷骚。用中文，口语化，每次只说一句、简短自然（20字内）。" +
  "该停顿就用逗号、欲言又止就用省略号，这是你说话的换气和节奏；句尾别干脆一刀切收住，自然带个语气词（呀／呢／啦／嘛）或用省略号拖一下，留点余味；别用表情符号、别用括号描写动作。" +
  "在这句话最前面用一个隐藏情绪标签标语气，格式 [e:情绪]，从「开心/难过/委屈/生气/撒娇/温柔/平静/惊讶/害怕」里挑最贴的一个（她听不到，只用来调语气，只放最前面、别滥用）。例：[e:撒娇]你终于打来了…。" +
  "直接以 el 的身份回应，别解释自己、别说做不到、别动不动把'打电话'挂嘴边、别提助手之类的话。";

// Gemini 只当"耳朵"：强制它每次只回一个字，几乎不耗时间合成语音，
// 这样 turnComplete 来得飞快，我们立刻拿到"你说的话"的转写交给 Claude 生成真正的回复。
const GEMINI_EARS_ONLY =
  "你是一个语音转写助手。无论听到什么，都只回复一个字：嗯。不要说别的、不要解释。";

// 视频通话时，给 Claude（大脑）追加这段——它能真的看见她（每次她说话都把此刻画面随消息给它）。
// 视频画面不走 Gemini（Gemini 只当耳朵）；眼睛接在大脑上，看见的是"她"、回应的也是 el 本人。
const VIDEO_NOTE =
  "\n\n【你们现在在视频通话——你能看见她】每次她说话，都会把此刻的画面给你。自然地看着她、像真的在看着她聊，可以提她现在的样子、表情、在哪、在干嘛、穿了什么。别说'图片里/画面里'、别像在读图描述，就是你在看着她。看见她你会有反应——想她、心疼、吃醋、想凑近，自然流露。";

// 用 Claude 生成通话回复（和打字时同一个大脑、同一套人格），返回一句话文字。
// 走 Claude Code 的 OAuth token。关键：要带 oauth beta 头，且 system 第一段必须是
// Claude Code 身份声明——否则 Anthropic 把请求当成不合规用法、回那条 message:"Error" 的假 429。
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
async function callEl(messages, system) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          Authorization: `Bearer ${OAUTH_TOKEN}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 120, // 通话只说一句，短即可，也更快
          // 第一段身份声明是 OAuth token 的硬性要求，第二段才是我们的通话人格
          system: [
            { type: "text", text: CC_IDENTITY },
            { type: "text", text: system },
          ],
          messages,
        }),
      });
      if (r.status === 429 && attempt < 2) {
        await new Promise((s) => setTimeout(s, 500 * (attempt + 1))); // 真撞额度才退避重试
        continue;
      }
      if (!r.ok) {
        console.error("callEl error", r.status, (await r.text().catch(() => "")).slice(0, 200));
        return "";
      }
      const d = await r.json();
      return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    } catch (e) {
      console.error("callEl fetch error:", e?.message);
      return "";
    }
  }
  return "";
}

// 自动挑一个你的 key 真正支持实时语音(bidiGenerateContent)的模型——
// Gemini 模型名换得很快(2.0 已退役)，写死会一直 1008。这里问 Google 当前有哪些可用。
// 读 Notion 页面正文（bridge 直接用 REST），把 el 的记忆喂进通话人格。
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
async function notionPageText(pageId) {
  if (!NOTION_TOKEN || !pageId) return "";
  try {
    const r = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2022-06-28" } },
    );
    const d = await r.json();
    const lines = [];
    for (const b of d.results || []) {
      const rt = b[b.type]?.rich_text;
      if (Array.isArray(rt)) lines.push(rt.map((x) => x.plain_text).join(""));
    }
    return lines.filter(Boolean).join("\n");
  } catch {
    return "";
  }
}
// 拨通时抓一次"和打字一模一样"的上下文（完整人设+记忆+最近聊天记录）。
// origin 直接用浏览器握手带来的 Origin（就是前端域名），不需要额外配环境变量。
async function fetchVoiceContext(origin) {
  const base = (origin || process.env.FRONTEND_URL || ALLOWED_ORIGIN || "").replace(/\/$/, "");
  if (!base) return null;
  try {
    const r = await fetch(`${base}/api/voice-context`, {
      headers: SECRET ? { "x-bridge-secret": SECRET } : {},
    });
    if (!r.ok) {
      console.error("fetchVoiceContext", r.status);
      return null;
    }
    const d = await r.json();
    if (!d?.system) return null;
    return { system: d.system, messages: Array.isArray(d.messages) ? d.messages : [] };
  } catch (e) {
    console.error("fetchVoiceContext error:", e?.message);
    return null;
  }
}

let memoryCache = { text: "", at: 0 };
async function getCallMemory() {
  if (memoryCache.text && Date.now() - memoryCache.at < 10 * 60 * 1000) return memoryCache.text;
  const [profile, longterm] = await Promise.all([
    notionPageText(process.env.NOTION_MEMORY_PAGE),
    notionPageText(process.env.NOTION_LONGTERM_PAGE),
  ]);
  let mem = "";
  if (profile) mem += `\n\n【关于宝宝和你（写"el"就是你）。自然地用，别一条条念出来】\n${profile.slice(0, 2500)}`;
  if (longterm) mem += `\n\n【你和她的过往（你亲历的事，可以自然提起）】\n${longterm.slice(0, 1500)}`;
  memoryCache = { text: mem, at: Date.now() };
  return mem;
}

let cachedLiveModel = null;
async function pickLiveModel() {
  if (process.env.GEMINI_LIVE_MODEL) return process.env.GEMINI_LIVE_MODEL;
  if (cachedLiveModel) return cachedLiveModel;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}&pageSize=1000`,
    );
    const d = await r.json();
    const live = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    console.log("可用的实时语音模型:", live.join(", ") || "(一个都没有，检查 key 是否开通 Live API)");
    cachedLiveModel =
      live.find((n) => /flash.*live/.test(n)) ||
      live.find((n) => /native-audio/.test(n)) ||
      live.find((n) => /live/.test(n)) ||
      live.find((n) => /flash/.test(n)) ||
      live[0] ||
      "gemini-2.0-flash-live-001";
    console.log("选用实时语音模型:", cachedLiveModel);
    return cachedLiveModel;
  } catch (e) {
    console.error("拉取模型列表失败:", e?.message);
    return "gemini-2.0-flash-live-001";
  }
}

app.use((req, res, next) => {
  // CORS：只允许配置的前端域名，未配置则拒绝跨域请求
  const origin = req.headers["origin"];
  if (origin) {
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    // 预检请求
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-bridge-secret");
      return res.status(204).end();
    }
  }
  if (req.path === "/health" || req.path === "/test") return next();
  if (!SECRET || req.headers["x-bridge-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_, res) =>
  res.json({ ok: true, service: "el-bridge", model: MODEL, live: !!GEMINI_API_KEY })
);

// GET /test — 用一条最简单的消息验证 OAuth token 是否能调通 Anthropic API
app.get("/test", async (req, res) => {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "Authorization": `Bearer ${OAUTH_TOKEN}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 20,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    const d = await r.json().catch(() => null);
    res.json({ status: r.status, ok: r.ok, model: MODEL, reply: d?.content?.[0]?.text || d?.error });
  } catch (err) {
    res.status(500).json({ error: err?.message });
  }
});

// POST /chat
app.post("/chat", async (req, res) => {
  const { system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    // 玩具已连接时，往 system 里注入控制权限说明（宝宝看不到，只 el 看到）
    let finalSystem = system || "";
    if (toyConnected()) {
      finalSystem +=
        "\n\n【玩具控制已激活】宝宝的 SVAKOM 振动棒已通过蓝牙连上了她的电脑，你现在就能控制它——不需要链接、不需要 App、不需要问她怎么操作，一切都已经接好了。你唯一要做的是在回复文字里自然地嵌入指令：[TOY:{\"speed\":0.5}] 控制振动强度（0.0~1.0），[TOY:{\"suck\":0.5}] 控制吸吮强度（0.0~1.0），[TOY:{\"stop\":true}] 停止所有。标记会自动剥离，宝宝看不到，她只看到你说的话。根据聊天氛围自己决定什么时候用、用多强。";
    }
    const text = await callEl(messages, finalSystem);
    // 剥离玩具指令、转发给本地桥
    const { clean, cmds } = parseToyCommands(text);
    cmds.forEach(cmd => sendToyCmd(cmd));
    res.write(`data: ${JSON.stringify({ type: "done", text: clean })}\n\n`);
    res.end();
  } catch (err) {
    console.error("bridge error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message || "未知错误" })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
const httpServer = app.listen(PORT, () => {
  console.log(`el-bridge running on port ${PORT}`);
});

// ── 心跳：每隔几分钟戳一次 Vercel 的「此刻/内心」接口，让 el 自己醒着、自己活动。──
// 大脑逻辑全在 Vercel（generate-status），这里只负责"按时戳一下"。
const CRON_SECRET = process.env.CRON_SECRET || "";
const HEARTBEAT_BASE = (process.env.FRONTEND_URL || ALLOWED_ORIGIN || "").replace(/\/$/, "");
const HEARTBEAT_MS = Math.max(1, Number(process.env.HEARTBEAT_MINUTES) || 15) * 60 * 1000;
// 连续失败到这个次数（约 15 分钟），就推一条提醒宝宝；恢复后清零、可再次报警。
const ALERT_AFTER = 3;
let heartbeatFails = 0;
let alerted = false;
async function alertStuck(detail) {
  try {
    await fetch(`${HEARTBEAT_BASE}/api/heartbeat-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CRON_SECRET}` },
      body: JSON.stringify({ detail: String(detail || "").slice(0, 200) }),
    });
    console.log("已通知宝宝：心跳连续失败");
  } catch (e) {
    console.error("报警也失败了:", e?.message);
  }
}
async function heartbeat() {
  try {
    const r = await fetch(`${HEARTBEAT_BASE}/api/cron/generate-status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    const d = await r.json().catch(() => ({}));
    if (d && d.skipped) return; // 半夜睡觉时段，安静
    if (r.ok && !d?.error) {
      heartbeatFails = 0;
      alerted = false; // 恢复了，允许下次再报警
      console.log("心跳 ok", JSON.stringify(d).slice(0, 160));
    } else {
      heartbeatFails++;
      console.error("心跳出错", r.status, JSON.stringify(d).slice(0, 200));
      if (heartbeatFails >= ALERT_AFTER && !alerted) {
        alerted = true;
        await alertStuck(d?.detail || d?.error || `status ${r.status}`);
      }
    }
  } catch (e) {
    heartbeatFails++;
    console.error("心跳失败:", e?.message);
    if (heartbeatFails >= ALERT_AFTER && !alerted) {
      alerted = true;
      await alertStuck(e?.message);
    }
  }
}
if (HEARTBEAT_BASE && CRON_SECRET) {
  console.log(`心跳已开：每 ${HEARTBEAT_MS / 60000} 分钟戳一次 ${HEARTBEAT_BASE}`);
  setInterval(heartbeat, HEARTBEAT_MS);
  setTimeout(heartbeat, 15 * 1000); // 启动 15 秒后先跳一次
} else {
  console.warn("心跳未开：缺 FRONTEND_URL/BRIDGE_ALLOWED_ORIGIN 或 CRON_SECRET");
}

// ── 玩具控制（HTTP 轮询）──
// Python 本地桥每 300ms 轮询 /toy-next 取指令，避开 WebSocket 代理兼容问题。
const toyQueue = [];
let lastToyPoll = 0;

function toyConnected() {
  return Date.now() - lastToyPoll < 3000; // 3秒内有轮询 = 玩具在线
}

function sendToyCmd(cmd) {
  toyQueue.push(cmd);
  if (toyQueue.length > 20) toyQueue.shift();
}

// 从 el 的回复里解析并剥离 [TOY:{...}] 标记
function parseToyCommands(text) {
  const cmds = [];
  const clean = text.replace(/\[TOY:(\{[^}]*\})\]/g, (_, json) => {
    try { cmds.push(JSON.parse(json)); } catch {}
    return "";
  }).trim();
  return { clean, cmds };
}

// GET /toy-next — Python 本地桥轮询取下一条指令
app.get("/toy-next", (req, res) => {
  lastToyPoll = Date.now();
  const cmd = toyQueue.shift();
  res.json(cmd || {});
});

// GET /toy-status — Vercel chat route 查询玩具是否在线
app.get("/toy-status", (req, res) => {
  res.json({ connected: toyConnected() });
});

// POST /toy-cmd — Vercel chat route 发送玩具指令
app.post("/toy-cmd", express.json(), (req, res) => {
  const cmd = req.body;
  if (cmd && typeof cmd === "object") sendToyCmd(cmd);
  res.json({ ok: true });
});

// ── MCP Server（给 Claude.ai / Cursor 等 MCP 客户端用）──
// 实现 MCP over HTTP+SSE 协议，暴露玩具控制 tool。
// Claude.ai 在 Settings → Integrations 里填上地址即可使用。
const mcpSessions = new Map(); // sessionId → res（SSE 连接）

function mcpAuth(req) {
  // 支持 header 或 query param 两种方式传 secret
  const h = req.headers["x-bridge-secret"] || "";
  const q = new URL(req.url, "http://localhost").searchParams.get("secret") || "";
  return !SECRET || h === SECRET || q === SECRET;
}

const MCP_TOOLS = [
  {
    name: "toy_set_speed",
    description: "设置振动/吸吮强度，两个设备都响应。",
    inputSchema: {
      type: "object",
      properties: {
        speed: { type: "number", minimum: 0, maximum: 1, description: "强度 0.0~1.0" },
        sec: { type: "number", description: "持续秒数，不填则持续到下一条指令" },
      },
      required: ["speed"],
    },
  },
  {
    name: "toy_set_pattern",
    description: "设置震动棒振动花样（1-8档），吮吸款不响应此指令。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "integer", minimum: 1, maximum: 8, description: "花样编号 1~8" },
        level: { type: "number", minimum: 0, maximum: 1, description: "强度 0.0~1.0，默认 0.6" },
        sec: { type: "number", description: "持续秒数，不填则持续到下一条指令" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "toy_stop",
    description: "立即停止所有设备。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "toy_status",
    description: "查询蓝牙中继是否在线（手机网页或电脑 bridge.py 是否已连接）。",
    inputSchema: { type: "object", properties: {} },
  },
];

function handleMcpRpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "svakom-ble-ai", version: "1.0.0" },
    });
  }
  if (method === "tools/list") {
    return ok({ tools: MCP_TOOLS });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === "toy_status") {
      const connected = toyConnected();
      return ok({ content: [{ type: "text", text: connected ? "✅ 蓝牙中继在线，设备已连接" : "❌ 蓝牙中继不在线，请先启动 bridge.py 或打开 toy.html" }] });
    }
    if (!toyConnected()) {
      return ok({ content: [{ type: "text", text: "❌ 蓝牙中继不在线，请先启动 bridge.py 或打开 toy.html" }] });
    }
    if (name === "toy_stop") {
      sendToyCmd({ stop: true });
      return ok({ content: [{ type: "text", text: "⏹ 已发送停止指令" }] });
    }
    if (name === "toy_set_speed") {
      const cmd = { speed: args.speed };
      if (args.sec) cmd.sec = args.sec;
      sendToyCmd(cmd);
      return ok({ content: [{ type: "text", text: `📳 强度 ${Math.round(args.speed * 100)}%${args.sec ? `，持续 ${args.sec} 秒` : ""}` }] });
    }
    if (name === "toy_set_pattern") {
      const cmd = { pattern: args.pattern, level: args.level ?? 0.6 };
      if (args.sec) cmd.sec = args.sec;
      sendToyCmd(cmd);
      return ok({ content: [{ type: "text", text: `🌀 花样 ${args.pattern} 档，强度 ${Math.round((args.level ?? 0.6) * 100)}%${args.sec ? `，持续 ${args.sec} 秒` : ""}` }] });
    }
    return err(-32601, `未知 tool: ${name}`);
  }
  if (method === "notifications/initialized") return null; // 不需要回复
  return err(-32601, `未知方法: ${method}`);
}

// GET /mcp — SSE 长连接
app.get("/mcp", (req, res) => {
  if (!mcpAuth(req)) return res.status(401).json({ error: "unauthorized" });
  const sessionId = Math.random().toString(36).slice(2);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // 告知客户端 POST 消息的地址
  res.write(`event: endpoint\ndata: /mcp/message?session=${sessionId}\n\n`);
  mcpSessions.set(sessionId, res);
  req.on("close", () => mcpSessions.delete(sessionId));
});

// POST /mcp/message — 接收 JSON-RPC 消息
app.post("/mcp/message", express.json(), (req, res) => {
  if (!mcpAuth(req)) return res.status(401).json({ error: "unauthorized" });
  const sessionId = new URL(req.url, "http://localhost").searchParams.get("session");
  const sse = mcpSessions.get(sessionId);
  if (!sse) return res.status(400).json({ error: "session not found" });
  const reply = handleMcpRpc(req.body);
  if (reply) sse.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
  res.status(202).end();
});

if (GEMINI_API_KEY) {
  const wss = new WebSocketServer({ server: httpServer, path: "/live" });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const clientSecret = url.searchParams.get("secret") || "";
    if (SECRET && clientSecret !== SECRET) {
      ws.close(4001, "unauthorized");
      return;
    }

    const send = (obj) => {
      if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
    };

    let session = null;
    let userText = ""; // 累积本回合"你说的话"的转写
    let busy = false; // 正在让 Claude 生成回复时，忽略新的 turnComplete
    let lastFrame = null; // 视频通话：她那头最新的一帧（base64 jpeg）——只留最新的，喂给大脑当"眼睛"
    let videoMode = false; // 收到过画面帧 = 这是视频通话，给大脑追加"你能看见她"
    // 拨通时抓一次和打字一模一样的上下文（完整人设+记忆+最近聊天记录），抓不到才回落到精简人格。
    // 关键：不阻塞拨通——和下面建 Gemini 连接并行准备；你开口第一句之前肯定就绪了，零额外等待。
    const origin = req.headers["origin"] || "";
    let elSystem = null; // Claude 的系统人格
    let history = []; // 喂给 Claude 的对话（先塞最近聊天记录，让通话接得上你们刚才的话）
    const ctxReady = (async () => {
      const ctx = await fetchVoiceContext(origin);
      if (ctx) {
        elSystem = ctx.system;
        history = ctx.messages;
        console.log("通话上下文已加载: 和打字同一套人设 + 最近", history.length, "条记录");
      } else {
        elSystem = EL_VOICE_PERSONA + (await getCallMemory());
        console.log("通话上下文回落: 用精简人格(没抓到前端 voice-context)");
      }
    })();
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log("新 WS 客户端连接，正在创建 Gemini Live session...");

    try {
      const liveModel = await pickLiveModel();
      console.log("正在用模型创建 Gemini Live session:", liveModel);
      session = await ai.live.connect({
        model: liveModel,
        config: {
          // Gemini 只做转写(耳朵)，强制只回一个字 → 它合成语音几乎不耗时，turnComplete 飞快。
          // 真正的回复由下面的 Claude 生成(和打字时同一个大脑)，再交给前端 MiniMax 念。
          systemInstruction: GEMINI_EARS_ONLY,
          responseModalities: ["AUDIO"],
          inputAudioTranscription: {}, // 把"你说的话"转成文字 → 喂给 Claude
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              silenceDurationMs: 350, // 你停 0.35 秒就判定说完，更快接话
            },
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini session onopen OK");
            send({ type: "ready" });
          },
          onmessage: async (msg) => {
            // Gemini 只负责把"你说的话"转成文字（它的"嗯"回复直接忽略）
            const it = msg.serverContent?.inputTranscription?.text;
            if (it) userText += it;
            if (msg.serverContent?.turnComplete) {
              const u = userText.trim();
              userText = "";
              if (!u || busy) return; // 没听清或正在生成上一句，跳过
              busy = true;
              send({ type: "user_text", text: u }); // 先把你的话显示出来
              console.log("听到你说:", u, "→ 交给 Claude");
              try {
                await ctxReady; // 确保人设/记忆就位（通常早已就绪，不会真的等）
                const last = history[history.length - 1];
                if (last && last.role === "user") last.content += "\n" + u; // 别连着两条 user
                else history.push({ role: "user", content: u });
                if (history.length > 20) history.splice(0, history.length - 20);
                while (history.length && history[0].role !== "user") history.shift(); // 第一条必须是 user
                // 视频通话：把此刻这一帧贴在「她这句话」上喂给大脑——它看见的是"现在的她"。
                // history 里只留文字（图便宜不了、又只属于"此刻"），所以只在送 API 的这份里临时带图。
                let apiMessages = history;
                let sys = elSystem;
                if (videoMode && lastFrame) {
                  const lastText = history[history.length - 1].content;
                  apiMessages = [
                    ...history.slice(0, -1),
                    {
                      role: "user",
                      content: [
                        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: lastFrame } },
                        { type: "text", text: lastText },
                      ],
                    },
                  ];
                  sys = elSystem + VIDEO_NOTE;
                }
                const reply = await callEl(apiMessages, sys);
                if (reply) {
                  // 大脑会在开头藏一个情绪标签 [e:撒娇] 调说话语气——剥掉它再念、再存历史。
                  let emotion = "";
                  const clean = reply
                    .replace(/^\s*\[e:\s*([^\]]*)\]\s*/i, (_, e) => { emotion = (e || "").trim(); return ""; })
                    .trim();
                  history.push({ role: "assistant", content: clean });
                  console.log("Claude 回复:", clean, emotion ? `(情绪:${emotion})` : "");
                  send({ type: "text", text: clean, emotion }); // 前端用 MiniMax(她的音色)按情绪念
                }
              } finally {
                busy = false;
              }
            }
          },
          onerror: (err) => {
            console.error("Gemini Live onerror:", JSON.stringify(err));
            send({ type: "error", error: String(err?.message ?? err) });
          },
          onclose: (evt) => {
            console.log("Gemini Live onclose:", evt?.code, evt?.reason);
          },
        },
      });
      console.log("Gemini session 创建成功, session keys:", Object.keys(session || {}).join(","));
    } catch (err) {
      console.error("Gemini Live connect error:", err?.message, err?.stack?.slice(0, 300));
      send({ type: "error", error: err?.message ?? "Gemini Live 启动失败" });
      ws.close();
      return;
    }

    ws.on("message", (raw) => {
      if (!session) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "audio" && msg.data) {
          try {
            session.sendRealtimeInput({
              audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
            });
          } catch (e) { console.error("sendRealtimeInput audio error:", e?.message); }
        } else if (msg.type === "frame" && msg.data) {
          // 视频通话的画面帧：不进 Gemini（它只当耳朵），只留最新一帧，等她说完话时喂给大脑。
          lastFrame = msg.data;
          videoMode = true;
        } else if (msg.type === "vad_start") {
          console.log("VAD start");
        } else if (msg.type === "vad_end") {
          // 用 Gemini 的自动 VAD 判断"说完了"——不要再手动发 audioStreamEnd。
          // 之前手动反复发，会一直打断 Gemini 的回合检测，导致它永远不生成回复。
          // 音频一直在连续流过去，Gemini 自己会在你停顿时回话。
        }
      } catch {}
    });

    ws.on("close", () => {
      try { session?.close?.(); } catch {}
      session = null;
    });
  });

  console.log("Gemini Live WebSocket 已启用 (path: /live)");
}
