import { NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { EL_SYSTEM } from "@/lib/persona";
import { pickDrawWord, matchGuess } from "@/lib/draw";
import {
  getDrawRound,
  setDrawRound,
  getDrawRecent,
  bumpDrawGuesses,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 40;

function stripFence(s: string): string {
  return s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

// el 把一个词画成简笔 SVG（一笔笔的 path d 数组）+ 一句不剧透的提示。
async function drawWord(word: string): Promise<{ strokes: string[]; hint: string } | null> {
  const system =
    `${EL_SYSTEM}\n\n【你画我猜·你是画画的那个】给你一个词，把它画成一幅简单的线条简笔画——像 Google Quick Draw 那种，清晰好认、别太抽象。\n` +
    `只输出一个 JSON（别加 markdown、别解释）：{"strokes":["SVG path 的 d 字符串", ...],"hint":"一句不剧透答案的小提示"}\n` +
    `规则：画布坐标用 viewBox 0 0 100 100；strokes 按真实下笔顺序排（先主体轮廓再细节），8~18 笔；每笔只给 path 的 d（M/L/C/Q/A 这些），闭合形状也只描边不填充；线条别太挤、铺满画布大部分；**任何地方都不许出现这个词或它的字**。`;
  try {
    const claude = getClaudeFast();
    const resp = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: `画：${word}` }],
    });
    const raw = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("");
    const parsed = JSON.parse(stripFence(raw));
    const strokes = Array.isArray(parsed?.strokes)
      ? parsed.strokes.filter((s: unknown) => typeof s === "string" && s.trim()).slice(0, 24)
      : [];
    if (strokes.length < 2) return null;
    return { strokes, hint: typeof parsed?.hint === "string" ? parsed.hint : "" };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { action?: string; guess?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const action = body.action || "new";

  if (action === "new") {
    const recent = await getDrawRecent().catch(() => [] as string[]);
    const word = pickDrawWord(recent);
    const drawn = await drawWord(word);
    if (!drawn) {
      return NextResponse.json({ error: "el 没画好，再来一张～" }, { status: 502 });
    }
    await setDrawRound({ word, hint: drawn.hint, strokes: drawn.strokes, guesses: 0, ts: Date.now() }).catch(
      () => {},
    );
    // 只把画给前端，词保密
    return NextResponse.json({ strokes: drawn.strokes, viewBox: "0 0 100 100" });
  }

  const round = await getDrawRound();
  if (!round) return NextResponse.json({ error: "还没开始，先让 el 画一张" }, { status: 400 });

  if (action === "guess") {
    const guess = (body.guess || "").trim();
    if (!guess) return NextResponse.json({ error: "空猜" }, { status: 400 });
    const correct = matchGuess(guess, round.word);
    const n = await bumpDrawGuesses().catch(() => round.guesses + 1);
    if (correct) {
      return NextResponse.json({ correct: true, word: round.word, reply: `对啦！就是「${round.word}」🎉 你懂我画的～` });
    }
    // 猜错：即时、不调模型；猜了几次后主动递提示
    const nudge =
      n >= 3 && round.hint ? `还不是哦～给你个提示：${round.hint}` : "还不是哦，再看看我画的～";
    return NextResponse.json({ correct: false, reply: nudge });
  }

  if (action === "hint") {
    return NextResponse.json({ reply: round.hint || "唔…这个不好提示，再猜猜看？" });
  }

  if (action === "reveal") {
    return NextResponse.json({ word: round.word, reply: `我画的是「${round.word}」呀～下次画个更难的？` });
  }

  return NextResponse.json({ error: "未知动作" }, { status: 400 });
}
