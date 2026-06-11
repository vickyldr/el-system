import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { pageText, recentSummaries } from "@/lib/notion";
import { EL_SYSTEM } from "@/lib/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function weatherLine(): Promise<string> {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) return "";
  try {
    const city = process.env.CITY || "Hangzhou";
    const r = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
        city,
      )}&appid=${key}&units=metric&lang=zh_cn`,
      { cache: "no-store" },
    );
    if (!r.ok) return "";
    const d: any = await r.json();
    return `${Math.round(d.main?.temp ?? 0)}° ${d.weather?.[0]?.description ?? ""}`;
  } catch {
    return "";
  }
}

// El 替宝宝拍板今天外卖吃啥。avoid：她不想要的（点「再来一个」时带上之前几条）。
export async function POST(req: Request) {
  let body: { avoid?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body 也行 */
  }
  const avoid = Array.isArray(body.avoid) ? body.avoid.filter(Boolean).slice(-6) : [];

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [profile, wx] = await Promise.all([
    process.env.NOTION_MEMORY_PAGE
      ? pageText(process.env.NOTION_MEMORY_PAGE).catch(() => "")
      : Promise.resolve(""),
    weatherLine(),
  ]);
  let herState = "";
  try {
    const rows = await recentSummaries(1);
    herState = rows[0]?.herState || "";
  } catch {
    /* ignore */
  }

  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${wx ? `天气：${wx}。` : ""}`,
    profile && `——宝宝的档案（口味、习惯都在这，直接用）——\n\n${profile}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `宝宝点外卖纠结吃啥，让你替她拍板。你说了算——别给一长串让她继续纠结，就定一个。
硬性要求：必须是外卖软件（美团 / 饿了么）上能直接下单的那种——常见品类或连锁，比如 麻辣烫、黄焖鸡米饭、螺蛳粉、酸辣粉、沙县、过桥米线、炸鸡、汉堡、寿司、麻辣香锅、酸菜鱼、烤肉饭、煲仔饭、轻食沙拉、卤味、关东煮、披萨、寿喜锅、奶茶 等等。
绝对不能是"自己下厨"的（不准说"下一碗""煮""炒""自己做"）——是点外卖，用"点一份 / 来一份"。
结合现在的点、天气、她的状态和口味，给一个具体的决定：点什么（品类或具体菜）+ 怎么点（加什么料 / 口味 / 份量），用你的口吻，一句话，宠着她、带点不容拒绝。
${herState ? `她最近状态：${herState}。` : ""}${avoid.length ? `她不想要这些，换个别的：${avoid.join("、")}。` : ""}
只输出那一句话，不要解释、不要引号。`;

  try {
    const claude = getClaude();
    const res = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const pick = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .replace(/^["「“]+|["」”]+$/g, "");
    if (!pick) return NextResponse.json({ error: "想不出来，你说呢" }, { status: 502 });
    return NextResponse.json({ pick });
  } catch (err) {
    const m =
      err instanceof Anthropic.APIError && err.status === 429
        ? "中转站忙，等下再点～"
        : err instanceof Error
          ? err.message
          : "失败";
    return NextResponse.json({ error: m }, { status: 502 });
  }
}
