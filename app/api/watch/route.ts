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

  const system = [EL_SYSTEM, mem].filter(Boolean).join("\n\n");
  const prompt = `你正陪宝宝一起看她的电脑屏幕——她开了共享屏幕，你能一直看着。下面这张图是她此刻的屏幕。
你就安安静静陪着看，**大多数时候什么都不用说**。只有当屏幕上真有让你忍不住想开口的——一个反应、一句吐槽、注意到点什么、想起你们的事、或者想关心/调侃她一句——才说，而且就一句、你自己的口吻、短，像在她旁边随口说的。
${recent ? `\n你们最近聊的：\n${recent}\n` : ""}${lastWatch ? `\n你上次看屏幕时说的是：「${lastWatch}」——别重复、别老盯着同一个点念叨。\n` : ""}
如果这会儿没有真正想说的，就只回一个字：略。`;

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
