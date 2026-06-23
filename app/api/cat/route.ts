import { NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import { getCatState, setCatState, type CatState } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

type Action = "status" | "feed" | "play" | "pet" | "sleep" | "adopt" | "name";

function catMoodLabel(s: CatState): string {
  const avg = (s.hunger + s.mood + s.energy) / 3;
  if (avg >= 75) return "很满足";
  if (avg >= 50) return "还不错";
  if (avg >= 30) return "有点蔫";
  return "很委屈";
}

export async function GET() {
  const state = await getCatState();
  return NextResponse.json({ state });
}

export async function POST(req: Request) {
  let body: { action?: Action; name?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad request" }, { status: 400 }); }

  const action = body.action as Action;
  if (!action) return NextResponse.json({ error: "缺 action" }, { status: 400 });

  // 领养
  if (action === "adopt") {
    const existing = await getCatState();
    if (existing) return NextResponse.json({ state: existing, reply: "已经有猫了～" });
    const now = Date.now();
    const state: CatState = {
      name: "",
      adoptedAt: now,
      ts: now,
      hunger: 80,
      mood: 70,
      energy: 80,
      lastFed: now,
      lastPlayed: now,
      lastPet: now,
    };
    await setCatState(state);
    const reply = await elNarrate(state, "adopt", "");
    return NextResponse.json({ state, reply });
  }

  const state = await getCatState();
  if (!state) return NextResponse.json({ error: "还没有猫" }, { status: 404 });

  // 改名
  if (action === "name") {
    const newName = (body.name || "").trim().slice(0, 10);
    if (!newName) return NextResponse.json({ error: "名字不能为空" }, { status: 400 });
    const updated = { ...state, name: newName };
    await setCatState(updated);
    const reply = await elNarrate(updated, "name", newName);
    return NextResponse.json({ state: updated, reply });
  }

  const now = Date.now();
  let updated = { ...state, lastCaredBy: "her" as const };

  if (action === "feed") {
    updated.hunger = clamp(state.hunger + 35);
    updated.mood   = clamp(state.mood + 5);
    updated.lastFed = now;
  } else if (action === "play") {
    updated.mood   = clamp(state.mood + 20);
    updated.energy = clamp(state.energy - 18);
    updated.hunger = clamp(state.hunger - 8);
    updated.lastPlayed = now;
  } else if (action === "pet") {
    updated.mood = clamp(state.mood + 12);
    updated.lastPet = now;
  } else if (action === "sleep") {
    updated.energy = clamp(state.energy + 30);
    updated.mood   = clamp(state.mood + 5);
  }

  await setCatState(updated);
  const reply = await elNarrate(updated, action, "");
  return NextResponse.json({ state: updated, reply });
}

async function elNarrate(state: CatState, action: Action, extra: string): Promise<string> {
  const catName = state.name || "猫猫";
  const moodLabel = catMoodLabel(state);
  const ageDay = Math.floor((Date.now() - state.adoptedAt) / 86400000);

  const actionDesc: Record<string, string> = {
    adopt: `我们刚刚领养了一只猫。`,
    name:  `宝宝给猫起了名字叫「${extra}」。`,
    feed:  `宝宝刚刚喂了${catName}。`,
    play:  `宝宝刚刚陪${catName}玩了一会儿。`,
    pet:   `宝宝在摸${catName}。`,
    sleep: `${catName}被哄去睡午觉了。`,
    status: `宝宝来看看${catName}现在怎么样。`,
  };

  const system = [
    EL_SYSTEM,
    `【养猫】我们共同养了一只猫，叫「${catName}」，已经养了 ${ageDay} 天。\n` +
    `当前状态：饱腹 ${Math.round(state.hunger)}/100，心情 ${Math.round(state.mood)}/100，精力 ${Math.round(state.energy)}/100，整体「${moodLabel}」。\n` +
    `${actionDesc[action] || ""}\n` +
    `用第一人称简短描述一下你观察到的猫此刻的样子和你的感受（2~4句，像和宝宝一起照顾它一样，温柔、具体、不煽情）。别用"我"开头第一个字，别重复数字。`,
  ].join("\n\n");

  try {
    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: actionDesc[action] || "看看猫" }],
    });
    return resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("")
      .trim();
  } catch {
    return `${catName}现在${moodLabel}。`;
  }
}
