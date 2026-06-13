import { NextResponse } from "next/server";
import { recentSummaries, todayInBeijing } from "@/lib/notion";
import { resolveNeteaseSong } from "@/lib/netease";
import { getDailySong, getCache, setCache } from "@/lib/store";

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

// 网易云观察 里歌名一般在《》中，《...》连同前面的歌手当推荐，其余当理由。
function splitSong(text: string): { song_recommendation: string; song_reason: string } {
  const t = (text || "").trim();
  if (!t) return { song_recommendation: "", song_reason: "" };
  const end = t.indexOf("》");
  if (end >= 0) {
    return {
      song_recommendation: t.slice(0, end + 1).trim(),
      song_reason: t
        .slice(end + 1)
        .replace(/^[。，,、\s]+/, "")
        .trim(),
    };
  }
  const m = t.match(/^[^。！？!?\n]*[。！？!?]?/);
  const rec = (m?.[0] || t).trim();
  return { song_recommendation: rec, song_reason: t.slice(rec.length).trim() };
}

// El 看着天气说的一句叮嘱。
function weatherNote(temp: number, desc: string): string {
  if (/雨|雪|雷|drizzle|rain|snow|storm/i.test(desc)) return "带把伞，别淋着，宝宝。";
  if (temp <= 10) return "冷，外套穿厚点，别逞强。";
  if (temp <= 16) return "有点凉，加件衣服。";
  if (temp >= 30) return "热，多喝水，别中暑。";
  return "今天还行，照顾好自己。";
}

// El 根据气温给穿搭建议。
function outfitTip(temp: number, desc: string): string {
  const rain = /雨|drizzle|rain|storm/i.test(desc);
  if (temp <= 5)  return rain ? "大衣加厚底，记得带伞。" : "羽绒服拿出来吧，别冻着。";
  if (temp <= 10) return rain ? "厚外套加防水的，别感冒。" : "厚外套，围巾也戴上。";
  if (temp <= 16) return rain ? "薄外套加伞，里面可以轻薄点。" : "薄外套或卫衣，早晚会凉。";
  if (temp <= 22) return rain ? "带把伞，穿件能挡风的。" : "长袖就够，轻松出门。";
  if (temp <= 28) return rain ? "短袖加伞，雨天别穿白色。" : "短袖随便穿，挺舒服的。";
  return rain ? "热还下雨，透气的衣服加伞。" : "短袖短裤，防晒别忘了。";
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
  { temp: number; desc: string; city: string; note: string; outfit: string; icon: string } | null
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
    return { temp, desc, city, note: weatherNote(temp, desc), outfit: outfitTip(temp, desc), icon: weatherEmoji(desc) };
  } catch {
    return null;
  }
}

export async function GET() {
  // 45 秒缓存：此刻每小时才变、天气/网易云变化慢，省掉每次刷新都现读 Notion+天气+网易云。
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

  // 优先用 cron 生成的「此刻」；没有就回落到日记/网易云观察。
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
    ({ song_recommendation, song_reason } = splitSong(latest?.musicObservation ?? ""));
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

  const [weather, song] = await Promise.all([
    getWeather(),
    song_recommendation
      ? resolveNeteaseSong(song_recommendation).catch(() => null)
      : Promise.resolve(null),
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
    date: latest?.date ?? null,
  };
  await setCache("el:statuscache", JSON.stringify(result), 180).catch(() => {});
  return NextResponse.json(result);
}
