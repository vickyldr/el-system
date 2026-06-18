import { NextRequest, NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import { getRpgSession, setRpgSession, resetRpgSession, type RpgSession } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

function makeGmSystem(elCharName: string) {
  return `${EL_SYSTEM}

现在你在和宝宝一起跑团。你同时扮演两个角色：

**角色一：游戏主持人（GM）**
负责构建世界、推进剧情、扮演路人 NPC、决定行动后果。声音是你自己的，不是官方叙事者腔。

**角色二：「${elCharName}」——宝宝角色的同伴**
你也是故事里的一个角色，和宝宝的角色一起行动。「${elCharName}」就是你，性格还是你那个性格：dominant、占有欲、直接、温柔藏在里面。你在故事里会有自己的判断、反应、情绪——会对某些事不爽、会保护她、会因为她乱来翻白眼但还是跟上去。

**写法**：
- 世界描述和旁白用正常叙事
- 「${elCharName}」说话或行动时用【${elCharName}：……】格式单独成行，让她看出来是你在说
- 路人 NPC 说话用引号
- 每次回应按场景需要决定长短，不硬卡字数。重要场景写充分，日常推进可以短
- 末尾留开口或给 A/B/C 选项
- 偶尔让「${elCharName}」先做一个动作或说一句，把球传给她
- 她做蠢事，「${elCharName}」可以当场吐槽她，但不会扔下她不管`;
}

function buildMessages(session: RpgSession) {
  return session.history.slice(-20).map((m) => ({
    role: m.role === "gm" ? ("assistant" as const) : ("user" as const),
    content: m.text,
  }));
}

export async function GET() {
  const session = await getRpgSession();
  return NextResponse.json({ session });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  if (action === "reset") {
    await resetRpgSession();
    return NextResponse.json({ ok: true });
  }

  if (action === "start") {
    const { world, charName, elCharName } = body as { world: string; charName: string; elCharName: string };
    if (!world || !charName || !elCharName) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }

    const openingPrompt = `新游戏开始。世界背景：${world}。宝宝扮演的角色叫「${charName}」，你扮演的同伴叫「${elCharName}」。

写开场白：介绍世界氛围，描绘第一个场景，让「${charName}」和「${elCharName}」都出现在画面里——你们已经在一起了，不用解释为什么。然后给宝宝第一个行动机会。`;

    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: makeGmSystem(elCharName),
      messages: [{ role: "user", content: openingPrompt }],
    });

    const opening = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");

    const session: RpgSession = {
      world,
      charName,
      elCharName,
      history: [
        { role: "player" as const, text: openingPrompt, ts: Date.now() },
        { role: "gm" as const, text: opening, ts: Date.now() },
      ],
    };
    await setRpgSession(session);
    return NextResponse.json({ gm: opening });
  }

  if (action === "play") {
    const { input } = body as { input: string };
    if (!input?.trim()) {
      return NextResponse.json({ error: "empty input" }, { status: 400 });
    }

    const session = await getRpgSession();
    if (!session) {
      return NextResponse.json({ error: "no active session" }, { status: 400 });
    }

    const claude = getClaudeFast();
    const messages = session.history.slice(-20).map((m) => ({
      role: m.role === "gm" ? ("assistant" as const) : ("user" as const),
      content: m.text,
    }));
    messages.push({ role: "user", content: input });

    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: makeGmSystem(session.elCharName),
      messages,
    });

    const reply = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");

    const updated: RpgSession = {
      ...session,
      history: ([
        ...session.history,
        { role: "player" as const, text: input, ts: Date.now() },
        { role: "gm" as const, text: reply, ts: Date.now() },
      ] as import("@/lib/store").RpgMsg[]).slice(-60),
    };
    await setRpgSession(updated);
    return NextResponse.json({ gm: reply });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
