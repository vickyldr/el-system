import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { recentSummaries } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";

export const runtime = "nodejs";

type ChatTurn = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  let body: { message?: string; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "message 不能为空" }, { status: 400 });
  }

  // 注入最近 3 条每日总结作为记忆上下文（拉不到也能聊）。
  let memory = "";
  try {
    memory = buildMemoryContext(await recentSummaries(3));
  } catch {
    memory = "";
  }
  const system = memory ? `${EL_SYSTEM}\n\n${memory}` : EL_SYSTEM;

  // history 可选：前端带上最近几轮，El 才有上下文连续性。
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  const messages = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: message },
  ];

  try {
    const claude = getClaude();
    const res = await claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system,
      messages,
    });

    const reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    return NextResponse.json({ reply });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status ?? 502 },
      );
    }
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
