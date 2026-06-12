import express from "express";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

// 启动时把模型写入 claude 的配置，确保它用我们指定的模型
const model = process.env.BRIDGE_MODEL || "claude-sonnet-4-6";
try {
  const configDir = path.join(os.homedir(), ".claude");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ model }, null, 2)
  );
  console.log(`claude config: model=${model}`);
} catch (e) {
  console.warn("写 claude settings 失败:", e.message);
}

const app = express();
app.use(express.json({ limit: "10mb" }));

const SECRET = process.env.BRIDGE_SECRET || "";

// claude CLI 的路径（Railway 上装在 node_modules/.bin/）
const CLAUDE_BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "node_modules",
  ".bin",
  "claude"
);

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (SECRET && req.headers["x-bridge-secret"] !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_, res) => res.json({ ok: true, service: "el-bridge" }));

// POST /chat
app.post("/chat", async (req, res) => {
  const { system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空" });
  }

  // 把历史 + 系统提示拼成 claude --print 能理解的 prompt
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
  const prompt = `${systemBlock}${historyBlock}Human: ${lastText}\n\nAssistant:`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  let output = "";
  let settled = false;

  const done = () => {
    if (settled) return;
    settled = true;
    res.write(`data: ${JSON.stringify({ type: "done", text: output.trim() })}\n\n`);
    res.end();
  };

  try {
    const env = { ...process.env };

    const args = ["--print", "--no-stream"];
    // 通过环境变量指定模型（--model flag 在 --print 模式下有 bug）
    env.ANTHROPIC_MODEL = process.env.BRIDGE_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const proc = spawn(CLAUDE_BIN, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
      // 流式把增量发出去
      res.write(`data: ${JSON.stringify({ type: "text", text: chunk.toString() })}\n\n`);
    });

    proc.stderr.on("data", (d) => console.error("[claude stderr]", d.toString()));

    proc.on("close", done);
    proc.on("error", (err) => {
      console.error("spawn error:", err);
      if (!settled) {
        settled = true;
        res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
        res.end();
      }
    });

    req.on("close", () => { if (!settled) proc.kill(); });
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
