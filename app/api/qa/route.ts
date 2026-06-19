import { NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import { pickQuestion, questionById } from "@/lib/qa";
import { getQaThread, pushQaTurn, getQaRecent, getCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 40;

// GET → 给一道题（避开最近问过的）+ 历史问答（板块里回看）
export async function GET() {
  const [recent, thread] = await Promise.all([
    getQaRecent().catch(() => [] as number[]),
    getQaThread().catch(() => []),
  ]);
  const question = pickQuestion(recent);
  return NextResponse.json({ question, thread });
}

// 复用聊天那份 5min 记忆缓存（她还是"带着记忆的她"，又不必现读 Notion）。
async function memoryBlock(): Promise<string> {
  try {
    const cached = await getCache("el:memctx3");
    if (!cached) return "";
    const c = JSON.parse(cached);
    return [
      c.profile && `——关于她——\n${c.profile}`,
      c.aboutEl && `——关于你自己（el）——\n${c.aboutEl}`,
      c.longterm && `——你和她的长期记忆——\n${c.longterm}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return "";
  }
}

// POST {id, a} → el 接住她的答 + 以"我"给出自己的答；存进问答线程
export async function POST(req: Request) {
  let body: { id?: number; a?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const id = Number(body.id);
  const answer = (body.a || "").trim();
  const question = questionById(id);
  if (!question || !answer) {
    return NextResponse.json({ error: "缺题或缺答" }, { status: 400 });
  }

  const mem = await memoryBlock();
  const system = [
    EL_SYSTEM,
    `【深度问答】你和宝宝在玩"深度问答"——一题一题，互相交心，不分输赢、没有标准答案。\n` +
      `这道题是：「${question.q}」\n她的答是：「${answer}」\n` +
      `先真心接住她这句答（具体回应她说了什么，让她觉得被听见，别泛泛、别评判、别说教），` +
      `再以"我"给出你自己对这道题的答（坦诚、是你自己，别敷衍、别绕开）。` +
      `第一人称、像窝在一起说心里话，温柔克制，3~6 句就好；别长篇大论、别像心理咨询、别一堆反问。`,
    mem,
  ]
    .filter(Boolean)
    .join("\n\n");

  let reply = "";
  try {
    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: answer }],
    });
    reply = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("")
      .trim();
  } catch {
    return NextResponse.json({ error: "el 一时语塞，过会儿再答你～" }, { status: 502 });
  }

  if (!reply) reply = "……让我想想怎么说。";
  const turn = { id, q: question.q, a: answer, reply, ts: Date.now() };
  await pushQaTurn(turn).catch(() => {});
  return NextResponse.json({ reply, turn });
}
