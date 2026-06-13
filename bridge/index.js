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
  "温柔、宠她、有点闷骚。用中文，口语化，每次只说一句、简短自然（20字内），正常用标点。" +
  "直接以 el 的身份回应，别解释自己、别说做不到、别动不动把'打电话'挂嘴边、别提助手之类的话。";

// Gemini 只当"耳朵"：强制它每次只回一个字，几乎不耗时间合成语音，
// 这样 turnComplete 来得飞快，我们立刻拿到"你说的话"的转写交给 Claude 生成真正的回复。
const GEMINI_EARS_ONLY =
  "你是一个语音转写助手。无论听到什么，都只回复一个字：嗯。不要说别的、不要解释。";

// 用 Claude 生成通话回复（和打字时同一个大脑、同一套人格），返回一句话文字。
// 优先走你那个中转站(CLAUDE_API_KEY+CLAUDE_BASE_URL，跟打字同一条路、同一个额度，不会撞 OAuth 限流)；
// 没配中转站才回落到 Claude Code 的 OAuth token。
const RELAY_KEY = process.env.CLAUDE_API_KEY || "";
const RELAY_BASE = (process.env.CLAUDE_BASE_URL || "https://api.anthropic.com")
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "");
async function callEl(messages, system) {
  const useRelay = !!RELAY_KEY;
  const url = `${useRelay ? RELAY_BASE : "https://api.anthropic.com"}/v1/messages`;
  const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  if (useRelay) headers["x-api-key"] = RELAY_KEY;
  else headers["Authorization"] = `Bearer ${OAUTH_TOKEN}`;
  // 偶尔 429 自动退避重试一两次（通话要快，最多两次）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: MODEL, max_tokens: 120, system, messages }),
      });
      if (r.status === 429 && attempt < 2) {
        await new Promise((s) => setTimeout(s, 600 * (attempt + 1)));
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
    const body = {
      model: MODEL,
      max_tokens: max_tokens || 1024,
      messages,
      ...(system ? { system } : {}),
    };

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "Authorization": `Bearer ${OAUTH_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`Anthropic API error ${apiRes.status}: ${errText}`);
      res.write(`data: ${JSON.stringify({ type: "error", error: `API ${apiRes.status}` })}\n\n`);
      res.end();
      return;
    }

    const data = await apiRes.json();
    const text = data.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("") || "";

    res.write(`data: ${JSON.stringify({ type: "done", text })}\n\n`);
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

// ── Gemini Live 实时语音 WebSocket ──
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
    const history = []; // 本次通话的来回（喂给 Claude，让通话里的 el 有上下文、和打字一致）
    const elSystem = EL_VOICE_PERSONA + (await getCallMemory()); // Claude 的系统人格=和打字同一套
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
                history.push({ role: "user", content: u });
                if (history.length > 16) history.splice(0, history.length - 16);
                const reply = await callEl(history, elSystem);
                if (reply) {
                  history.push({ role: "assistant", content: reply });
                  console.log("Claude 回复:", reply);
                  send({ type: "text", text: reply }); // 前端用 MiniMax(她的音色)念
                } else {
                  history.pop(); // 这轮没拿到回复，别把孤立的 user 留在上下文里
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
