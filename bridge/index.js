import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const SECRET = process.env.BRIDGE_SECRET || "";
const MODEL = process.env.BRIDGE_MODEL || "claude-sonnet-4-6";
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";

if (!OAUTH_TOKEN) {
  console.warn("警告: CLAUDE_CODE_OAUTH_TOKEN 未设置");
}
console.log(`el-bridge 启动，model=${MODEL}`);

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (SECRET && req.headers["x-bridge-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_, res) => res.json({ ok: true, service: "el-bridge", model: MODEL }));

// POST /chat
app.post("/chat", async (req, res) => {
  const { system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

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
app.listen(PORT, () => {
  console.log(`el-bridge running on port ${PORT}`);
});
