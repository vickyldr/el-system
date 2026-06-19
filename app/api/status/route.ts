import { NextResponse } from "next/server";
import { recentSummaries, todayInBeijing } from "@/lib/notion";
import { resolveNeteaseSong } from "@/lib/netease";
import { getDailySong, getCache, setCache, pulseSoma } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 不缓存，每次拿最新状态

// el日记 是整段日记，启发式拆成 mood（第一句）+ thought（其余）。
// cron 写入短状态后会更贴合。
function splitDiary(text: string): { mood: string; thought: string } {
  const t = (text || "").trim();
  if (!t) return { mood: "", thought: "" };
  const m = t.match(/^[^。！？!?\n]*[。！？!?]?/);
  const mood = (m?.[0] || t).trim();
  const thought = t.slice(mood.length).trim();
  return { mood, thought };
}

// El 根据气温+天气给的穿衣推荐——具体、实用，像他在帮她拿衣服。
function outfitTip(temp: number, desc: string): string {
  const rain = /雨|drizzle|rain|storm/i.test(desc);
  const snow = /雪/.test(desc);
  if (temp <= 0)
    return rain || snow
      ? "羽绒服+厚毛衣打底，帽子手套围巾全戴上，鞋要防滑防水，路上慢点别摔。"
      : "羽绒服里加件毛衣，围巾帽子手套安排上，别露脚踝，手别揣兜里冻着。";
  if (temp <= 5)
    return rain
      ? "羽绒服+防水的鞋，里面加件毛衣，带伞，别让风灌进领口。"
      : "羽绒服或厚大衣，毛衣打底，围巾戴上，穿双暖和点的鞋。";
  if (temp <= 10)
    return rain
      ? "厚外套选防水的，里面卫衣或薄毛衣，记得带伞，别穿帆布鞋会湿透。"
      : "厚外套+卫衣/薄毛衣，早晚凉，围巾备着，鞋穿暖和的。";
  if (temp <= 16)
    return rain
      ? "风衣或薄外套+伞，里面长袖，早晚偏凉别只穿一件。"
      : "薄外套或卫衣，里面长袖，早晚会凉，加件好脱的最稳。";
  if (temp <= 22)
    return rain
      ? "长袖+能挡风的薄外套，带把伞，鞋选不怕湿的。"
      : "长袖或薄卫衣就舒服，怕晒的话备件薄外套挡太阳。";
  if (temp <= 28)
    return rain
      ? "短袖+一把伞，雨天别穿浅色容易透，多带双袜子更稳。"
      : "短袖短裙怎么舒服怎么穿，室内空调冷就揣件薄开衫。";
  return rain
    ? "又热又下雨，穿透气快干的料子，凉鞋+伞，别穿会闷的。"
    : "短袖短裤怎么凉快怎么来，防晒涂上，多带水别中暑。";
}

// 解析 cron 生成的「此刻」三行：心情 / 在想 / 歌：《X》— 理由
function parseNow(text: string): {
  mood: string;
  thought: string;
  outfit: string;
  song_recommendation: string;
  song_reason: string;
} {
  const lines = text.split(/\n+/).map((l) => l.trim());
  const pick = (label: string) => {
    const l = lines.find((x) => x.replace(/\s/g, "").startsWith(label));
    return l ? l.replace(/^[^：:]*[：:]/, "").trim() : "";
  };
  const mood = pick("心情") || lines[0] || "";
  const thought = pick("在想") || pick("在想什么");
  const outfit = pick("穿搭") || pick("穿衣");
  const songLine = pick("歌") || pick("想让你听");
  let song_recommendation = "";
  let song_reason = "";
  if (songLine) {
    const end = songLine.indexOf("》");
    if (end >= 0) {
      song_recommendation = songLine.slice(0, end + 1).trim();
      song_reason = songLine
        .slice(end + 1)
        .replace(/^[—\-、,，:：\s]+/, "")
        .trim();
    } else {
      song_recommendation = songLine;
    }
  }
  return { mood, thought, outfit, song_recommendation, song_reason };
}

// 根据天气描述给个符号。
function weatherEmoji(desc: string): string {
  if (/雷/.test(desc)) return "⛈️";
  if (/雪/.test(desc)) return "❄️";
  if (/雨/.test(desc)) return "🌧️";
  if (/雾|霾/.test(desc)) return "🌫️";
  if (/阴/.test(desc)) return "☁️";
  if (/多云|少云|云/.test(desc)) return "⛅️";
  if (/晴/.test(desc)) return "☀️";
  return "🌡️";
}

async function getWeather(): Promise<
  { temp: number; desc: string; city: string; outfit: string; icon: string } | null
> {
  const key = process.env.OPENWEATHER_API_KEY;
  const city = process.env.CITY || "Hangzhou";
  if (!key) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
      city,
    )}&appid=${key}&units=metric&lang=zh_cn`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const d: any = await r.json();
    const temp = Math.round(d.main?.temp ?? 0);
    const desc = d.weather?.[0]?.description ?? "";
    return { temp, desc, city, outfit: outfitTip(temp, desc), icon: weatherEmoji(desc) };
  } catch {
    return null;
  }
}

export async function GET() {
  // 缓存：此刻每小时才变、天气变化慢，省掉每次刷新都现读 Notion+天气。
  const cached = await getCache("el:statuscache").catch(() => null);
  if (cached) {
    try {
      return NextResponse.json(JSON.parse(cached));
    } catch {
      /* 缓存坏了就重算 */
    }
  }

  let latest;
  try {
    const rows = await recentSummaries(1);
    latest = rows[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取 Notion 失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // 优先用 cron 生成的「此刻」；没有就回落到日记。
  const nowText = (latest?.now ?? "").trim();
  let mood: string;
  let thought: string;
  let outfit: string;
  let song_recommendation: string;
  let song_reason: string;
  if (nowText) {
    ({ mood, thought, outfit, song_recommendation, song_reason } = parseNow(nowText));
  } else {
    ({ mood, thought } = splitDiary(latest?.elDiary ?? ""));
    outfit = "";
    song_recommendation = "";
    song_reason = "";
  }

  // 歌以"每日一首"的稳定存档为准，别被每小时的心情文字覆盖丢了。
  try {
    const ds = await getDailySong(todayInBeijing());
    if (ds) {
      const end = ds.indexOf("》");
      if (end >= 0) {
        song_recommendation = ds.slice(0, end + 1).trim();
        song_reason = ds
          .slice(end + 1)
          .replace(/^[—\-、,，:：\s]+/, "")
          .trim();
      } else {
        song_recommendation = ds;
        song_reason = "";
      }
    }
  } catch {
    /* 拿不到就用上面解析的 */
  }

  const [weather, song, pulse] = await Promise.all([
    getWeather(),
    song_recommendation
      ? resolveNeteaseSong(song_recommendation).catch(() => null)
      : Promise.resolve(null),
    pulseSoma().catch(() => ({ v: 0, a: 0.3 })), // 心跳脉搏：唤醒→快慢、好坏→冷暖
  ]);

  const result = {
    mood,
    thought,
    outfit: outfit || null,
    song_recommendation,
    song_reason,
    song_url: song?.url ?? null,
    el_note: latest?.elNote ?? "",
    her_state: latest?.herState ?? "",
    weather,
    pulse,
    date: latest?.date ?? null,
  };
  await setCache("el:statuscache", JSON.stringify(result), 180).catch(() => {});
  return NextResponse.json(result);
}
