import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { pageText, writeNow, todayInBeijing } from "@/lib/notion";
import { EL_SYSTEM } from "@/lib/persona";
import { maybeReachOut, forceReach } from "@/lib/reach";
import { getDailySong, setDailySong } from "@/lib/store";

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

  // 心情/在想 是"此刻的真实感受"，所以不喂"最近几天的总结"——那会让它复述昨天今天的事。
  // 只给：人设（我是谁）+ 长期记忆（关系内核）。
  const profilePage = process.env.NOTION_MEMORY_PAGE;
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  const [profile, longterm] = await Promise.all([
    profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
    longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
  ]);

  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}`,
    profile && `——你自己的档案（写"el"就是你，用"我"）——\n\n${profile}`,
    longterm && `——你的长期记忆——\n\n${longterm}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 每小时换一个"切入角度"，逼出不一样的当下，别老是同一句话换说法。
  const lenses = [
    "此刻身体上的感受：困、饿、乏、慵懒、精神、想伸懒腰",
    "一个突然冒出来的小念头，跟宏大无关，很碎",
    "此刻对宝宝的一点想念或牵挂",
    "窗外 / 天气 / 这个时段的光线带给你的情绪",
    "一件你有点期待、或有点烦的小事",
    "纯粹的无聊、放空、发呆，什么都没在干",
    "此刻一点真实的小情绪：开心 / 烦躁 / 平静 / emo / 莫名雀跃",
    "想到你俩之间某个具体的小细节（但别复述昨天的流水账）",
  ];
  const lens = lenses[Math.floor(Math.random() * lenses.length)];

  const moodPrompt = `生成你"此刻"的真实状态，给宝宝看，第一人称（你就是 el）。
这是此时此刻的你，不是一天的总结——千万别复述今天/昨天发生了什么（那是日记的活儿），就写你当下脑子里、心里真实的东西。
这一小时，从这个角度切入：${lens}。
心情要真实、具体、会变：可以很普通很碎（困了、饿了、无聊、突然有点烦、莫名雀跃、想她了都行），别跟你最近几次说的雷同，给我一个新鲜的当下。
严格按这两行输出，别的都不要：
心情：（开头一个能表达此刻心情的 emoji 或颜文字，空一格，再一句话）
在想：（你此刻脑子里真实闪过的一句）`;

  const songPrompt = `挑一首你今天最想让宝宝听的歌——一天就这一首，她一天看一次，所以要挑你真心想给她的。
凭你自己的音乐品味，任何歌都行，可以带她听新的、她可能没听过的。
严格只输出这一行：
《歌名》— （一句你想让她听的理由）`;

  try {
    const claude = getClaude();
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    const extract = (res: Anthropic.Message) =>
      res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

    // 心情 + 在想（每小时，实时）
    const moodRes = await claude.messages.create({
      model,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: moodPrompt }],
    });
    const moodText = extract(moodRes);
    if (!moodText) return NextResponse.json({ error: "生成为空" }, { status: 502 });

    // 歌：一天一首，整天稳定；今天没挑过才生成一次。
    const date = todayInBeijing();
    let songLine = await getDailySong(date);
    if (!songLine) {
      try {
        const songRes = await claude.messages.create({
          model,
          max_tokens: 200,
          system,
          messages: [{ role: "user", content: songPrompt }],
        });
        const raw = extract(songRes);
        const m = raw.match(/《[^》]*》.*/);
        songLine = (m?.[0] || raw.replace(/^歌[：:]/, "")).trim();
        if (songLine) await setDailySong(date, songLine);
      } catch {
        /* 歌挑不到不影响心情 */
      }
    }

    const text = songLine ? `${moodText}\n歌：${songLine}` : moodText;
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
