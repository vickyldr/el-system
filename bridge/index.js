import express from "express";
import { query } from "@anthropic-ai/claude-code";
import { createRequire } from "module";

const app = express();
app.use(express.json({ limit: "10mb" }));

const SECRET = process.env.BRIDGE_SECRET || "";

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (SECRET && req.headers["x-bridge-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_, res) => res.json({ ok: true, service: "el-bridge" }));

app.post("/chat", async (req, res) => {
  const { system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空" });
  }

  const historyText = messages
    .slice(0, -1)
    .map((m) => {
      const text = Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("")
        : String(m.content || "");
      return `${m.role === "user" ? "Human" : "Assistant"}: ${text}`;
    })
    .join("\n\n");

  const lastMsg = messages[messages.length - 1];
  const lastText = Array.isArray(lastMsg.content)
    ? lastMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : String(lastMsg.content || "");

  const systemBlock = system ? `<system>\n${system}\n</system>\n\n` : "";
  const historyBlock = historyText ? `${historyText}\n\n` : "";
  const prompt = `${systemBlock}${historyBlock}Human: ${lastText}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const abort = new AbortController();
  req.on("close", () => abort.abort());

  let lastSent = "";
  let fullText = "";

  try {
    for await (const msg of query({
      prompt,
      abortController: abort,
      options: { maxTurns: 1, allowedTools: [] },
    })) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            const delta = block.text.slice(lastSent.length);
            if (delta) {
              lastSent = block.text;
              fullText = block.text;
              res.write(`data: ${JSON.stringify({ type: "text", text: delta })}\n\n`);
            }
          }
        }
      }
    }
    res.write(`data: ${JSON.stringify({ type: "done", text: fullText })}\n\n`);
    res.end();
  } catch (err) {
    if (err?.name === "AbortError") return res.end();
    console.error("bridge error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message || "未知错误" })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`el-bridge running on port ${PORT}`);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  未检测到 CLAUDE_CODE_OAUTH_TOKEN，请设置环境变量");
  }
});
