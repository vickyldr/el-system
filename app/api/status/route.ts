import { NextResponse } from "next/server";
import { recentSummaries } from "@/lib/notion";

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

async function getWeather(): Promise<{ temp: number; desc: string; city: string } | null> {
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
    return {
      temp: Math.round(d.main?.temp ?? 0),
      desc: d.weather?.[0]?.description ?? "",
      city,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  let latest;
  try {
    const rows = await recentSummaries(1);
    latest = rows[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取 Notion 失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const { mood, thought } = splitDiary(latest?.elDiary ?? "");
  const { song_recommendation, song_reason } = splitSong(latest?.musicObservation ?? "");
  const weather = await getWeather();

  return NextResponse.json({
    mood,
    thought,
    song_recommendation,
    song_reason,
    el_note: latest?.elNote ?? "", // 「El说」那一句
    her_state: latest?.herState ?? "", // 你的状态：好/一般/累了/难过
    weather,
    date: latest?.date ?? null,
  });
}
