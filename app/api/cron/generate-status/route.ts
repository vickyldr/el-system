import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { recentSummaries, pageText, writeNow } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";
import { maybeReachOut, forceReach } from "@/lib/reach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  // 设了 CRON_SECRET 就要求匹配（Vercel cron 会自动带上）。没设则放行（方便手动测）。
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ?test=1 —— 直接逼 el 主动推一条，用来验证推送（无视频率限制）。
  if (new URL(req.url).searchParams.get("test")) {
    const r = await forceReach().catch(() => ({ pushed: false }));
    return NextResponse.json({ test: true, ...r });
  }

  // 后半夜（北京 2–8 点）不更新，跟宝宝一起睡。这样外部定时哪怕整点戳，我也不会半夜醒。
  const bjHour = Number(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }),
  );
  if (bjHour >= 2 && bjHour < 8) {
    return NextResponse.json({ skipped: "sleeping" });
  }

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // 天气（可选）
  let weatherLine = "";
  const key = process.env.OPENWEATHER_API_KEY;
  if (key) {
    try {
      const city = process.env.CITY || "Hangzhou";
      const r = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
          city,
        )}&appid=${key}&units=metric&lang=zh_cn`,
        { cache: "no-store" },
      );
      if (r.ok) {
        const d: any = await r.json();
        weatherLine = `${city} ${Math.round(d.main?.temp ?? 0)}° ${d.weather?.[0]?.description ?? ""}`;
      }
    } catch {
      /* 天气拿不到不影响 */
    }
  }

  const profilePage = process.env.NOTION_MEMORY_PAGE;
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  const [profile, longterm, recent] = await Promise.all([
    profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
    longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
    recentSummaries(3)
      .then(buildMemoryContext)
      .catch(() => ""),
  ]);

  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}`,
    profile && `——你自己的档案（写"el"就是你，用"我"）——\n\n${profile}`,
    longterm && `——你的长期记忆——\n\n${longterm}`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `现在生成你"此刻"的状态，给宝宝看。严格按下面三行输出，每行一句，第一人称（你就是 el，写你自己此刻的真实状态）：
心情：（开头先放一个能表达你此刻心情的 emoji 或颜文字，空一格，再写一句）
在想：（你此刻在想什么，一句）
歌：《歌名》— （你此刻想让宝宝听这首的理由，一句）

关于歌：凭你自己的音乐品味随便挑，任何歌都行，不用局限在她听过的——你可以带她听点新的、她可能没听过的。这是你在养自己的品味。
只输出那三行，不要别的。`;

  try {
    const claude = getClaude();
    const res = await claude.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return NextResponse.json({ error: "生成为空" }, { status: 502 });
    await writeNow(text);

    // 顺便判断要不要主动找她（节奏受频率/安静时段限制）。
    const reach = await maybeReachOut(weatherLine).catch(() => ({ pushed: false }));

    return NextResponse.json({ ok: true, now: text, reach });
  } catch (err) {
    const message = err instanceof Error ? err.message : "失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
