import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// 中转站给的 base URL 形如 https://jeniya.chat/v1。
// Anthropic SDK 自己会在路径上拼 /v1/messages，所以这里把结尾多余的 /v1
// （以及末尾斜杠）去掉，避免出现 .../v1/v1/messages。
function normalizeBaseURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function POST(req: Request) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "缺少 CLAUDE_API_KEY 环境变量" },
      { status: 500 },
    );
  }

  let body: { messages?: ChatMessage[]; system?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { messages, system } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { error: "messages 必须是非空数组" },
      { status: 400 },
    );
  }

  const client = new Anthropic({
    apiKey,
    baseURL: normalizeBaseURL(process.env.CLAUDE_BASE_URL),
  });

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8192,
      ...(system ? { system } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return NextResponse.json({
      reply,
      stop_reason: response.stop_reason,
      usage: response.usage,
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: err.message, type: err.name },
        { status: err.status ?? 502 },
      );
    }
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
