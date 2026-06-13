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

// 自动挑一个你的 key 真正支持实时语音(bidiGenerateContent)的模型——
// Gemini 模型名换得很快(2.0 已退役)，写死会一直 1008。这里问 Google 当前有哪些可用。
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
    let replyText = ""; // 累积本回合 el 的回复文字
    let userText = ""; // 累积本回合"你说的话"的转写
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log("新 WS 客户端连接，正在创建 Gemini Live session...");

    try {
      const liveModel = await pickLiveModel();
      console.log("正在用模型创建 Gemini Live session:", liveModel);
      session = await ai.live.connect({
        model: liveModel,
        config: {
          systemInstruction: EL_VOICE_PERSONA,
          // 这些实时模型只支持 AUDIO 输出(TEXT 会 1007 直接踢)。
          // 所以让它出音频(我们丢掉不用)，同时开 outputAudioTranscription 拿到"它说的文字"，
          // 再把这段文字交给前端用 MiniMax(她捏的音色)念——又快、又是她的声音。
          responseModalities: ["AUDIO"],
          inputAudioTranscription: {}, // 把"你说的话"也转成文字，显示在对话框
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: false }, // 自动 VAD 判断回合
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini session onopen OK");
            send({ type: "ready" });
          },
          onmessage: (msg) => {
            // 你说的话（输入转写）
            const it = msg.serverContent?.inputTranscription?.text;
            if (it) userText += it;
            // el 说的话（输出转写）；音频 inlineData 忽略
            const ot = msg.serverContent?.outputTranscription?.text;
            if (ot) replyText += ot;
            for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
              if (part.text) replyText += part.text;
            }
            if (msg.serverContent?.turnComplete) {
              const u = userText.trim();
              const text = replyText.trim();
              userText = "";
              replyText = "";
              if (u) send({ type: "user_text", text: u }); // 先显示你的话
              console.log("Gemini turn complete, 转写:", text);
              if (text) send({ type: "text", text }); // 再 el 回复 + 念
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
