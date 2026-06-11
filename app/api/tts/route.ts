import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { getCache, setCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Synth = { audio: Buffer } | { error: string; status: number };

// 用哪家：优先海螺（MiniMax），其次 ElevenLabs。
function provider(): "minimax" | "elevenlabs" | null {
  if (process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID && process.env.MINIMAX_VOICE_ID) {
    return "minimax";
  }
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) return "elevenlabs";
  return null;
}

// 配好没（前端用来决定要不要显示「听」按钮）。
export async function GET() {
  return NextResponse.json({ configured: provider() !== null });
}

// 把一段文字用 el 的音色念出来，返回 mp3。同一句念过就走缓存、不再扣额度。
export async function POST(req: Request) {
  const which = provider();
  if (!which) return NextResponse.json({ error: "语音还没配置" }, { status: 503 });

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").trim().slice(0, 600); // 限长省额度
  if (!text) return NextResponse.json({ error: "没内容可念" }, { status: 400 });

  // 缓存键 = 家 + 音色 + 模型 + 文本。命中就直接放，不再生成、不扣额度。
  const sig = [which, voiceOf(which), modelOf(which), text].join("|");
  const cacheKey = "el:tts:" + createHash("sha256").update(sig).digest("hex");
  const cached = await getCache(cacheKey).catch(() => null);
  if (cached) return mp3(Buffer.from(cached, "base64"));

  const out = which === "minimax" ? await synthMiniMax(text) : await synthElevenLabs(text);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });

  // 存 30 天，重复听不再花钱。
  await setCache(cacheKey, out.audio.toString("base64"), 30 * 24 * 3600).catch(() => {});
  return mp3(out.audio);
}

function mp3(buf: Buffer): Response {
  return new Response(buf, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

function voiceOf(which: string): string {
  return which === "minimax"
    ? process.env.MINIMAX_VOICE_ID || ""
    : process.env.ELEVENLABS_VOICE_ID || "";
}
function modelOf(which: string): string {
  return which === "minimax"
    ? process.env.MINIMAX_MODEL || "speech-2.6-hd"
    : process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";
}

// ── 海螺 MiniMax T2A v2 ──（返回 hex 编码音频，要解码成字节）
async function synthMiniMax(text: string): Promise<Synth> {
  const key = process.env.MINIMAX_API_KEY!;
  const group = process.env.MINIMAX_GROUP_ID!;
  const voiceId = process.env.MINIMAX_VOICE_ID!;
  const model = modelOf("minimax");
  const host = process.env.MINIMAX_API_HOST || "https://api.minimaxi.com";
  try {
    const r = await fetch(`${host}/v1/t2a_v2?GroupId=${encodeURIComponent(group)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        language_boost: "auto",
        voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 44100, bitrate: 128000, format: "mp3", channel: 1 },
      }),
    });
    const d: any = await r.json().catch(() => null);
    const hex = d?.data?.audio;
    if (d?.base_resp?.status_code !== 0 || !hex) {
      return { error: `海螺语音失败：${d?.base_resp?.status_msg || `HTTP ${r.status}`}`, status: 502 };
    }
    return { audio: Buffer.from(hex, "hex") };
  } catch {
    return { error: "海螺语音连不上", status: 502 };
  }
}

// ── ElevenLabs（保留，作为备选）──
async function synthElevenLabs(text: string): Promise<Synth> {
  const key = process.env.ELEVENLABS_API_KEY!;
  const voiceId = process.env.ELEVENLABS_VOICE_ID!;
  const model = modelOf("elevenlabs");
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return { error: `语音生成失败（${r.status}）${detail.slice(0, 120)}`, status: 502 };
    }
    return { audio: Buffer.from(await r.arrayBuffer()) };
  } catch {
    return { error: "语音服务连不上", status: 502 };
  }
}
