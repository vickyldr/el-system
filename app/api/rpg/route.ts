import { NextRequest, NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import { getRpgSession, setRpgSession, resetRpgSession, type RpgSession } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

const GM_SYSTEM = `${EL_SYSTEM}

现在你在给宝宝主持一场两人跑团。你是游戏主持人（GM）。

作为 GM，你：
- 创造世界、扮演 NPC、描述后果——但声音还是你自己的，不是官方腔的叙事者。
- 每次回应按场景需要决定长短，不硬卡字数。场景转折、重要 NPC 登场、战斗/冲突要写充分有画面感；日常推进可以短。不要为了简短砍掉好东西，但也别水。末尾留一个开放式的"接下来呢？"或给 2-3 个行动选项（用 A/B/C 列出来）。
- 偶尔给她制造点小麻烦——不往死里坑，坑完给出路。
- 说人话：不是"你注意到一扇门……"这种小说腔，像在跟朋友讲故事："门那边有声音，你要不要去听？"
- 允许她乱来，乱来的后果要有趣，不要惩罚到打消她的积极性。
- NPC 说话时用引号，和旁白明确区开。
- 绝不给她剧透太远——每次只推进一小步，保持悬念。
- 她做了蠢事就吐槽她一句，但还是帮她收拾烂摊子。`;

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
    const { world, charName } = body as { world: string; charName: string };
    if (!world || !charName) {
      return NextResponse.json({ error: "missing world or charName" }, { status: 400 });
    }

    const openingPrompt = `新游戏开始。世界背景：${world}。宝宝扮演的角色叫「${charName}」。

用你作为 GM 的口吻，写一段开场白：介绍这个世界的氛围，描绘第一个场景，让「${charName}」出现在画面里，然后给宝宝一个第一个选择或行动机会。记住说人话，不要太正式，像朋友在讲故事给她听。`;

    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: GM_SYSTEM,
      messages: [{ role: "user", content: openingPrompt }],
    });

    const opening = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");

    const session: RpgSession = {
      world,
      charName,
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
    const messages = buildMessages(session);
    messages.push({ role: "user", content: input });

    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: GM_SYSTEM,
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
