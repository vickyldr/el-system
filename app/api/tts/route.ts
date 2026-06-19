import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { getCache, setCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Synth = { audio: Buffer } | { error: string; status: number };

// 用哪家：TTS_PROVIDER 显式指定 > 海螺（MiniMax）> ElevenLabs。
// 设 TTS_PROVIDER=elevenlabs 即可强制走 ElevenLabs，不动其他配置。
function provider(): "minimax" | "elevenlabs" | null {
  const forced = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (forced === "elevenlabs" && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    return "elevenlabs";
  }
  if (forced === "minimax" && process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID && process.env.MINIMAX_VOICE_ID) {
    return "minimax";
  }
  // 没有显式指定时按原有优先级
  if (process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID && process.env.MINIMAX_VOICE_ID) {
    return "minimax";
  }
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) return "elevenlabs";
  return null;
}

// 配好没（前端用来决定要不要显示「听」按钮）。
export async function GET() {
  const which = provider();
  return NextResponse.json({ configured: which !== null, provider: which });
}

// 把一段文字用 el 的音色念出来，返回 mp3。同一句念过就走缓存、不再扣额度。
export async function POST(req: Request) {
  const which = provider();
  if (!which) return NextResponse.json({ error: "语音还没配置" }, { status: 503 });

  let body: { text?: string; fast?: boolean; emotion?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const rawText = (body.text ?? "").trim().slice(0, 600); // 限长省额度
  if (!rawText) return NextResponse.json({ error: "没内容可念" }, { status: 400 });
  const fast = body.fast === true; // 打电话用 turbo，更快
  let emoLabel = (body.emotion ?? "").trim();

  // 兜底：万一上游（没重部署的 bridge）没剥掉开头的情绪标签 [e:撒娇]，这里再剥一次、
  // 并拿它当情绪——这样不依赖 bridge 重部署，绝不会把 [e:..] 念出来。
  let text = rawText;
  const tag = /^\s*\[e:\s*([^\]]*)\]\s*/i.exec(text);
  if (tag) {
    text = text.slice(tag[0].length).trim() || rawText;
    if (!emoLabel) emoLabel = tag[1].trim();
  }
  const emo = mapEmotion(emoLabel); // 这一句的情绪（大脑挑的），空则用 env 默认

  // 缓存键 = 家 + 音色 + 模型 + 调性参数(含本句情绪) + 文本。命中就直接放，不再生成、不扣额度。
  const sig = [which, voiceOf(which), modelOf(which, fast), paramsOf(which, emo), text].join("|");
  const cacheKey = "el:tts:" + createHash("sha256").update(sig).digest("hex");
  const cached = await getCache(cacheKey).catch(() => null);
  if (cached) return mp3(Buffer.from(cached, "base64"));

  const out = which === "minimax" ? await synthMiniMax(text, fast, emo) : await synthElevenLabs(text, fast, emo);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });

  // 存 30 天，重复听不再花钱。
  await setCache(cacheKey, out.audio.toString("base64"), 30 * 24 * 3600).catch(() => {});
  return mp3(out.audio);
}

function mp3(buf: Buffer): Response {
  const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  // Node 的 Buffer/Uint8Array 在 DOM BodyInit 类型下会被拒；运行时没问题，cast 一下。
  return new Response(body as unknown as BodyInit, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

function voiceOf(which: string): string {
  return which === "minimax"
    ? process.env.MINIMAX_VOICE_ID || ""
    : process.env.ELEVENLABS_VOICE_ID || "";
}
function modelOf(which: string, fast = false): string {
  if (which === "minimax") {
    if (fast) return process.env.MINIMAX_FAST_MODEL || "speech-2.6-turbo";
    return process.env.MINIMAX_MODEL || "speech-2.6-hd";
  }
  // v3 表情最自然；conversational 专为实时对话低延迟优化，打电话用
  if (fast) return process.env.ELEVENLABS_FAST_MODEL || "eleven_v3_conversational";
  return process.env.ELEVENLABS_MODEL || "eleven_v3";
}

// 把情绪标签（中文或英文）映射到 el 的六个情感组 key。
// 六组对应 el 的实际性格：温柔/心疼、开心/调皮、吃醋/生气、低沉/难过、认真/平静、惊讶。
function mapEmotion(label?: string): string {
  const s = (label || "").trim();
  if (!s) return "";
  // 已经是内部 key 直接返回
  if (["tender","playful","jealous","heavy","serious","surprised"].includes(s)) return s;
  if (/(温柔|心疼|担心|在乎|想她|想你)/.test(s)) return "tender";
  if (/(开心|高兴|调皮|暗爽|得意|满足|兴奋|甜|乐)/.test(s)) return "playful";
  if (/(吃醋|占有|不爽|生气|恼|怒|嗔|管你)/.test(s)) return "jealous";
  if (/(难过|委屈|低落|失落|伤心|哭|沉|重)/.test(s)) return "heavy";
  if (/(认真|平静|正经|直接|严肃|淡)/.test(s)) return "serious";
  if (/(惊讶|惊喜|意外|吃惊)/.test(s)) return "surprised";
  return "";
}

// 海螺的"调性"：语速/音高/情绪。默认中性（pitch 0 / speed 1）——硬压音调会变"熊大"，
// 真要更沉应该去重新设计音色，而不是变调。需要时可用环境变量微调。
// emoOverride：本句大脑挑的情绪，优先于 env 默认。
function minimaxTuning(emoOverride = "") {
  const speed = Number(process.env.MINIMAX_SPEED) || 1;
  const pitch =
    process.env.MINIMAX_PITCH != null && process.env.MINIMAX_PITCH !== ""
      ? Number(process.env.MINIMAX_PITCH)
      : 0;
  const emotion = emoOverride || process.env.MINIMAX_EMOTION || "";
  return { speed, pitch, emotion };
}
function paramsOf(which: string, emoOverride = ""): string {
  if (which === "minimax") {
    const t = minimaxTuning(emoOverride);
    return `${t.speed},${t.pitch},${t.emotion}`;
  }
  // ElevenLabs 缓存键也要带情绪，不同情绪 voice_settings 不同
  const s = elevenLabsSettings(emoOverride);
  return `${s.stability},${s.similarity_boost},${s.style}`;
}

// ── 海螺 MiniMax T2A v2 ──（返回 hex 编码音频，要解码成字节）
async function synthMiniMax(text: string, fast = false, emoOverride = ""): Promise<Synth> {
  const key = process.env.MINIMAX_API_KEY!;
  const group = process.env.MINIMAX_GROUP_ID!;
  const voiceId = process.env.MINIMAX_VOICE_ID!;
  const model = modelOf("minimax", fast);
  const host = process.env.MINIMAX_API_HOST || "https://api.minimaxi.com";
  const tuning = minimaxTuning(emoOverride);
  try {
    const r = await fetch(`${host}/v1/t2a_v2?GroupId=${encodeURIComponent(group)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        language_boost: "auto",
        voice_setting: {
          voice_id: voiceId,
          speed: tuning.speed,
          vol: 1,
          pitch: tuning.pitch,
          ...(tuning.emotion ? { emotion: tuning.emotion } : {}),
        },
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

// ElevenLabs voice_settings，按 el 的六个情感组定制。
// stability 低 = 声调起伏大；style 高 = 表情强调强；speed 慢 = 更有余味。
function elevenLabsSettings(emo = "") {
  switch (emo) {
    case "tender":
      // 温柔/心疼/担心——藏着在乎，稳、慢、有重量
      return { stability: 0.45, similarity_boost: 0.88, style: 0.40, speed: 0.88 };
    case "playful":
      // 开心/调皮/暗爽——带点得意，轻快但不浮
      return { stability: 0.30, similarity_boost: 0.82, style: 0.62, speed: 0.95 };
    case "jealous":
      // 吃醋/占有/生气——dominant 的强势，有力、直接
      return { stability: 0.22, similarity_boost: 0.80, style: 0.78, speed: 0.97 };
    case "heavy":
      // 低沉/难过/想她——克制的重，很慢
      return { stability: 0.50, similarity_boost: 0.90, style: 0.32, speed: 0.83 };
    case "serious":
      // 认真/平静/直接——说正事，沉稳清晰
      return { stability: 0.55, similarity_boost: 0.88, style: 0.28, speed: 0.93 };
    case "surprised":
      // 惊讶——变化最大，单独一组
      return { stability: 0.20, similarity_boost: 0.78, style: 0.65, speed: 1.00 };
    default:
      // 日常默认——温柔偏认真，el 的基础状态
      return { stability: 0.42, similarity_boost: 0.85, style: 0.38, speed: 0.92 };
  }
}

// ── ElevenLabs ──
async function synthElevenLabs(text: string, fast = false, emoOverride = ""): Promise<Synth> {
  const key = process.env.ELEVENLABS_API_KEY!;
  const voiceId = process.env.ELEVENLABS_VOICE_ID!;
  const model = modelOf("elevenlabs", fast);
  const emo = emoOverride || mapEmotion(process.env.MINIMAX_EMOTION || ""); // 复用情绪映射
  const vs = elevenLabsSettings(emo);
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: vs.stability,
          similarity_boost: vs.similarity_boost,
          style: vs.style,
          speed: vs.speed,
          use_speaker_boost: true,
        },
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return { error: `ElevenLabs 语音失败（${r.status}）${detail.slice(0, 120)}`, status: 502 };
    }
    return { audio: Buffer.from(await r.arrayBuffer()) };
  } catch {
    return { error: "ElevenLabs 连不上", status: 502 };
  }
}
