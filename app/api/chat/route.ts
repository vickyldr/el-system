import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { recentSummaries, pageText } from "@/lib/notion";
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

  // 记忆上下文：人物档案（长期核心）+ 最近 3 条每日总结。拉不到也能聊。
  const memoryPage = process.env.NOTION_MEMORY_PAGE;
  const [profile, recent] = await Promise.all([
    memoryPage ? pageText(memoryPage).catch(() => "") : Promise.resolve(""),
    recentSummaries(3)
      .then(buildMemoryContext)
      .catch(() => ""),
  ]);

  const system = [
    EL_SYSTEM,
    profile && `——人物档案——\n\n${profile}`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");

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
