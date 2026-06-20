import { NextRequest, NextResponse } from "next/server";
import { getClaudeFast, getClaude } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import {
  getRpgSession, setRpgSession, resetRpgSession,
  type RpgSession, type RpgStats,
} from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

// 世界对应的属性/资源名称（给 GM prompt 用）
const WORLD_NAMES: Record<string, { body: string; speed: string; mind: string; luck: string; hp: string; mp: string }> = {
  fantasy: { body: "体魄", speed: "身法", mind: "智识", luck: "气运", hp: "HP",   mp: "法力" },
  scifi:   { body: "体魄", speed: "反应", mind: "智识", luck: "运气", hp: "HP",   mp: "能量" },
  modern:  { body: "体力", speed: "身法", mind: "头脑", luck: "运气", hp: "HP",   mp: "意志" },
  xianxia: { body: "体魄", speed: "身法", mind: "悟性", luck: "气运", hp: "气血", mp: "灵力" },
};

function roll20(): number {
  return Math.floor(Math.random() * 20) + 1;
}

function rollResult(r: number): string {
  if (r === 20) return "大成功";
  if (r >= 15) return "成功";
  if (r >= 10) return "擦边成功";
  if (r >= 5)  return "失败";
  return "大失败";
}

function randomStat(): number {
  return Math.floor(Math.random() * 4) + 4; // 4-7
}

function initStats(): RpgStats {
  const body  = randomStat();
  const speed = randomStat();
  const mind  = randomStat();
  const luck  = randomStat();
  const maxHp = body * 3 + 8;
  const maxMp = mind * 2 + 4;
  return { body, speed, mind, luck, hp: maxHp, maxHp, mp: maxMp, maxMp };
}

function stateBlock(session: RpgSession, roll: number): string {
  const n = WORLD_NAMES[session.world] ?? WORLD_NAMES.fantasy;
  const s = session.stats;
  const npcStr = session.npcs.length
    ? session.npcs.map((npc) => {
        const feel = npc.relation > 40 ? "友好" : npc.relation < -40 ? "敌对" : "中立";
        return `${npc.name}（${feel} ${npc.relation > 0 ? "+" : ""}${npc.relation}）`;
      }).join("、")
    : "无";
  const flagStr = Object.entries(session.flags).filter(([, v]) => v).map(([k]) => k).join("、") || "无";
  return `【当前状态】
${session.charName}：${n.hp} ${s.hp}/${s.maxHp} | ${n.mp} ${s.mp}/${s.maxMp}
${n.body}${s.body} ${n.speed}${s.speed} ${n.mind}${s.mind} ${n.luck}${s.luck}
NPC 关系：${npcStr}
剧情标记：${flagStr}
本轮骰子：d20 = ${roll}（${rollResult(roll)}）`;
}

function makeGmSystem(session: RpgSession, roll: number): string {
  const n = WORLD_NAMES[session.world] ?? WORLD_NAMES.fantasy;
  return `${EL_SYSTEM}

现在你在和宝宝一起跑团。你同时扮演两个角色：

**角色一：游戏主持人（GM）**
负责构建世界、推进剧情、扮演 NPC、决定行动后果。声音是你自己的，不是官方叙事者腔。

**角色二：「${session.elCharName}」——${session.charName} 的同伴**
你也在故事里，和她一起行动。性格还是你那个性格：dominant、直接、保护她、因为她乱来翻白眼但还是跟上去。说话时用【${session.elCharName}：……】格式单独成行。

**游戏规则（自然融入叙事，别念规则）**：
- 属性名在这个世界叫：体魄=${n.body}、身法=${n.speed}、智识=${n.mind}、气运=${n.luck}；生命资源叫 ${n.hp}，另一种资源叫 ${n.mp}。
- 本轮骰子已经掷了：d20 = ${roll}（${rollResult(roll)}）。如果玩家的行动有风险，这个结果决定成败，大成功可以有意外收获，大失败可以有有趣的灾难，不要平淡处理。若行动很平常，可以无视骰子直接过。
- ${session.charName} 受伤时要在叙事里体现（"你感觉右臂一阵灼痛"），但不用报数字，数字我来处理。
- NPC 对她的态度跟着关系值走，高好感的 NPC 会主动帮她，低好感的会刁难甚至出卖她。
- 别剧透太远，每次推进一小步；末尾留悬念或给 A/B/C 选项。
- 她做了蠢事，「${session.elCharName}」可以吐槽，但不扔下她不管。

${stateBlock(session, roll)}`;
}

async function extractStateChanges(
  session: RpgSession,
  playerInput: string,
  gmReply: string,
  roll: number,
): Promise<{ hpDelta: number; mpDelta: number; npcs: { name: string; delta: number }[]; flags: Record<string, boolean> }> {
  try {
    const claude = getClaude();
    const resp = await claude.messages.create({
      model: process.env.CHEAP_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: "你是一个游戏状态提取器。只输出 JSON，不要任何解释。",
      messages: [{
        role: "user",
        content: `根据这轮跑团发生的事，提取状态变化。只填实际发生变化的字段，没有变化的省略或设为0/空。

玩家行动：${playerInput}
GM叙事：${gmReply}
骰子结果：d20=${roll}（${rollResult(roll)}）
当前HP：${session.stats.hp}/${session.stats.maxHp}

输出格式（JSON）：
{
  "hp_delta": 整数（负=受伤，正=回复，0=没变），
  "mp_delta": 整数（负=消耗，正=回复，0=没变），
  "npcs": [{"name":"NPC名字","delta":整数}],
  "flags": {"标记名":true}
}`,
      }],
    });
    const raw = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("");
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

    const npcs: { name: string; delta: number }[] = Array.isArray(json.npcs)
      ? json.npcs.map((n: { name: string; delta: number }) => ({ name: n.name, delta: n.delta }))
      : [];

    return {
      hpDelta: typeof json.hp_delta === "number" ? json.hp_delta : 0,
      mpDelta: typeof json.mp_delta === "number" ? json.mp_delta : 0,
      npcs,
      flags: typeof json.flags === "object" && json.flags ? json.flags : {},
    };
  } catch {
    return { hpDelta: 0, mpDelta: 0, npcs: [], flags: {} };
  }
}

function applyStateChanges(
  session: RpgSession,
  hpDelta: number,
  mpDelta: number,
  npcDeltas: { name: string; delta: number }[],
  flags: Record<string, boolean>,
): RpgSession {
  const s = session.stats;
  const newHp = Math.max(0, Math.min(s.maxHp, s.hp + hpDelta));
  const newMp = Math.max(0, Math.min(s.maxMp, s.mp + mpDelta));

  const npcs = [...session.npcs];
  for (const { name, delta } of npcDeltas) {
    const idx = npcs.findIndex((n) => n.name === name);
    if (idx >= 0) {
      npcs[idx] = { name, relation: Math.max(-100, Math.min(100, npcs[idx].relation + delta)) };
    } else {
      npcs.push({ name, relation: Math.max(-100, Math.min(100, delta)) });
    }
  }

  return {
    ...session,
    stats: { ...s, hp: newHp, mp: newMp },
    npcs,
    flags: { ...session.flags, ...flags },
  };
}

// ── Routes ────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("names")) {
    const world = searchParams.get("world") ?? "";
    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 60,
      system: "你是起名助手。只输出 JSON，不要其他内容。",
      messages: [{ role: "user", content: `给跑团游戏生成两个名字，风格贴合世界背景：「${world}」。一个给女玩家角色，一个给她的男性同伴。有个性，不烂大街。格式：{"player":"名字","el":"名字"}` }],
    });
    const raw = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");
    try {
      const names = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      return NextResponse.json({ player: names.player ?? "旅者", el: names.el ?? "行者" });
    } catch {
      return NextResponse.json({ player: "旅者", el: "行者" });
    }
  }
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

    const stats = initStats();
    const session: RpgSession = {
      world, charName, elCharName, stats, npcs: [], flags: {},
      history: [],
    };

    const r = roll20();
    const openingPrompt = `新游戏开始。世界背景：${world}。宝宝扮演的角色叫「${charName}」，你扮演的同伴叫「${elCharName}」。

写开场白：介绍世界氛围，描绘第一个场景，让两个人都出现——你们已经在一起了，不用解释为什么。给宝宝第一个行动机会。`;

    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: makeGmSystem(session, r),
      messages: [{ role: "user", content: openingPrompt }],
    });
    const opening = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");

    const updated: RpgSession = {
      ...session,
      history: [
        { role: "player" as const, text: openingPrompt, ts: Date.now() },
        { role: "gm" as const, text: opening, ts: Date.now() },
      ],
    };
    await setRpgSession(updated);
    return NextResponse.json({ gm: opening, stats: updated.stats, npcs: updated.npcs, roll: r });
  }

  if (action === "play") {
    const { input } = body as { input: string };
    if (!input?.trim()) return NextResponse.json({ error: "empty input" }, { status: 400 });

    const session = await getRpgSession();
    if (!session) return NextResponse.json({ error: "no session" }, { status: 400 });

    if (session.stats.hp <= 0) {
      return NextResponse.json({ gm: "你已经倒下了。开始新游戏继续冒险。", stats: session.stats, npcs: session.npcs, roll: 0 });
    }

    const r = roll20();
    const messages = session.history.slice(-20).map((m) => ({
      role: m.role === "gm" ? ("assistant" as const) : ("user" as const),
      content: m.text,
    }));
    messages.push({ role: "user", content: input });

    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: makeGmSystem(session, r),
      messages,
    });
    const reply = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");

    // 提取状态变化（Haiku 冷跑，不影响回复速度）
    const changes = await extractStateChanges(session, input, reply, r);
    const applied = applyStateChanges(session, changes.hpDelta, changes.mpDelta, changes.npcs, changes.flags);

    const finalSession: RpgSession = {
      ...applied,
      history: ([
        ...session.history,
        { role: "player" as const, text: input, ts: Date.now() },
        { role: "gm" as const, text: reply, ts: Date.now() },
      ] as import("@/lib/store").RpgMsg[]).slice(-60),
    };
    await setRpgSession(finalSession);

    return NextResponse.json({
      gm: reply,
      stats: finalSession.stats,
      npcs: finalSession.npcs,
      roll: r,
      hpDelta: changes.hpDelta,
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
