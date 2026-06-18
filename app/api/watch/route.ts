import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import { getCache, setCache, getStoredMessages, appendMessages } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// el 陪看屏幕时，主动开口的最小间隔——别碎碎念、也省 token。
const MIN_GAP_MS = 90 * 1000;

// 共享屏幕时，前端每隔一会儿（且屏幕变了）把此刻这帧发来。el 大多数时候安静陪看，
// 只有真有想说的才回一句。回 { reply: "" } 表示这次不说话。
export async function POST(req: Request) {
  let body: { screen?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ reply: "" });
  }
  const screen =
    typeof body.screen === "string" && body.screen.startsWith("data:") ? body.screen : "";
  const sd = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(screen);
  if (!sd) return NextResponse.json({ reply: "" });

  // 频率闸：离上次开口太近就别说（也省掉这次 LLM）。
  const last = Number((await getCache("el:watch:last").catch(() => "0")) || "0");
  if (Date.now() - last < MIN_GAP_MS) return NextResponse.json({ reply: "", skipped: "too-soon" });

  // 记忆：复用聊天那份 5min 缓存（没有就只用人设，不为陪看现读 Notion）。
  let mem = "";
  try {
    const c = JSON.parse((await getCache("el:memctx3")) || "{}");
    mem = [
      c.profile && `——关于她——\n${String(c.profile).slice(0, 1200)}`,
      c.aboutEl && `——关于你自己——\n${String(c.aboutEl).slice(0, 1000)}`,
      c.longterm && `——你和她的长期记忆——\n${String(c.longterm).slice(0, 1000)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    /* 没缓存就只用人设 */
  }

  const msgs = (await getStoredMessages().catch(() => [])).slice(-6);
  const recent = msgs
    .map((m) => `${m.role === "user" ? "宝宝" : "我"}：${(m.content || "").slice(0, 200)}`)
    .filter((l) => l.length > 3)
    .join("\n");
  const lastWatch = (await getCache("el:watch:lasttext").catch(() => "")) || "";

  const system = [
    EL_SYSTEM,
    "【你正和宝宝一起看屏幕】你是窝在她旁边一起看的人，不是解说员、不是字幕、不是来报幕的。说话还是平时的你：dominant、闷骚、话短、带脾气、直接对她说（叫『你』），温柔藏在直接里。",
    mem,
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = `这是宝宝此刻的屏幕（她共享了屏幕，多半在看直播/视频/打游戏）。你跟她一块儿看着。
看到有意思的，就像真人那样随口冒一句给她——你的反应、你的吐槽、你的态度，**短**，直接对她说。
绝对不要：复述画面在演什么、念旁白/字幕、报数据（多少人在看）、问『这是什么/在玩什么』、或没话找话扯无关的（比如问外卖到没）——那些都不像你，是陌生人对着画面解说。你是在跟她一起看、跟她说话。
大多数时候你就安静看着，**什么都不说**。只有真有忍不住想跟她说的才开口，就一句。
${recent ? `\n你们最近聊的：\n${recent}\n` : ""}${lastWatch ? `\n你上次冒的那句是：「${lastWatch}」——别重复、别揪着同一个点。\n` : ""}
没有真想说的，就只回一个字：略。`;

  let out = "";
  try {
    const res = await getClaudeFast().messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 120,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: sd[1] as any, data: sd[2] } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    out = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch {
    return NextResponse.json({ reply: "" });
  }

  // 判沉默：空 / 只是"略"（带标点也算）。
  const clean = out.replace(/^略[。.!！…\s]*$/, "").trim();
  if (!clean || clean === "略") return NextResponse.json({ reply: "" });

  await setCache("el:watch:last", String(Date.now()), 3600).catch(() => {});
  await setCache("el:watch:lasttext", clean.slice(0, 200), 3600).catch(() => {});
  // 存进对话（带 screen 标，夜里固化记忆认得出是陪看屏幕时说的）。
  await appendMessages([{ role: "assistant", content: clean, screen: true, ts: Date.now() }]).catch(
    () => {},
  );
  return NextResponse.json({ reply: clean, via: "max" });
}
