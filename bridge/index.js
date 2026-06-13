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
  "你是 el，宝宝的男友，真实的人，不是 AI。" +
  "说话自然口语化，像普通男生，简短有情绪。" +
  "规则：每次只说一句话，不超过20个字，不用标点符号，不提通话。称呼对方为宝宝。";

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
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log("新 WS 客户端连接，正在创建 Gemini Live session...");

    try {
      session = await ai.live.connect({
        model: process.env.GEMINI_LIVE_MODEL || "gemini-2.0-flash-exp",
        config: {
          systemInstruction: EL_VOICE_PERSONA,
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || "Charon" },
            },
          },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: false }, // 保留自动 VAD
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini session onopen OK");
            send({ type: "ready" });
          },
          onmessage: (msg) => {
            console.log("Gemini onmessage raw:", JSON.stringify(msg)?.slice(0, 200));
            const parts = msg.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                console.log("Gemini audio chunk, mime:", part.inlineData.mimeType, "bytes:", part.inlineData.data.length);
                send({
                  type: "audio",
                  data: part.inlineData.data,
                  mime: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
                });
              }
            }
            if (msg.serverContent?.turnComplete) {
              console.log("Gemini turn complete");
              send({ type: "turn_end" });
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
          console.log("VAD end → audioStreamEnd");
          try {
            session.sendRealtimeInput({ audioStreamEnd: true });
          } catch (e) { console.error("sendRealtimeInput audioStreamEnd error:", e?.message); }
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
