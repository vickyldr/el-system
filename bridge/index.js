const express = require("express");
const { query } = require("@anthropic-ai/claude-code");

const app = express();
app.use(express.json({ limit: "10mb" }));

// 简单鉴权——Vercel 传一个自定义密钥，防止别人乱调
const SECRET = process.env.BRIDGE_SECRET || "";

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (SECRET && req.headers["x-bridge-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_, res) => res.json({ ok: true, service: "el-bridge" }));

// POST /chat
// body: { system: string, messages: [{role, content}], max_tokens: number }
// 返回 SSE 流，每条 data: {"type":"text","text":"..."} 或 {"type":"done","text":"全文"}
app.post("/chat", async (req, res) => {
  const { system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空" });
  }

  // 把历史对话 + 系统提示拼成一个 prompt 传给 CC
  // CC SDK 的 query() 接受单个 prompt 字符串，我们把上下文都注进去
  const historyText = messages
    .slice(0, -1) // 最后一条是当前用户消息，单独处理
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

  let fullText = "";
  let lastSent = "";

  try {
    for await (const msg of query({
      prompt,
      abortController: abort,
      options: {
        maxTurns: 1,
        // 不给任何工具，纯对话模式
        allowedTools: [],
      },
    })) {
      // CC SDK 会逐步返回 assistant message 的 content
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
    console.warn("⚠️  未检测到 CLAUDE_CODE_OAUTH_TOKEN，请在环境变量中设置");
  }
});
