import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { getCache, setCache } from "@/lib/store";
import { getClaude } from "@/lib/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Synth = { audio: Buffer } | { error: string; status: number };

function provider(): "minimax" | "elevenlabs" | null {
  const forced = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (forced === "elevenlabs" && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    return "elevenlabs";
  }
  if (forced === "minimax" && process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID && process.env.MINIMAX_VOICE_ID) {
    return "minimax";
  }
  if (process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID && process.env.MINIMAX_VOICE_ID) {
    return "minimax";
  }
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) return "elevenlabs";
  return null;
}

export async function GET() {
  const which = provider();
  return NextResponse.json({ configured: which !== null, provider: which });
}

export async function POST(req: Request) {
  const which = provider();
  if (!which) return NextResponse.json({ error: "语音还没配置" }, { status: 503 });

  let body: { text?: string; fast?: boolean; emotion?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const rawText = (body.text ?? "").trim().slice(0, 600);
  if (!rawText) return NextResponse.json({ error: "没内容可念" }, { status: 400 });
  const fast = body.fast === true;
  let emoLabel = (body.emotion ?? "").trim();

  let text = rawText;
  const tag = /^\s*\[e:\s*([^\]]*)\]\s*/i.exec(text);
  if (tag) {
    text = text.slice(tag[0].length).trim() || rawText;
    if (!emoLabel) emoLabel = tag[1].trim();
  }
  const emo = mapEmotion(emoLabel);

  const sig = [which, voiceOf(which), modelOf(which, fast), paramsOf(which, emo), text].join("|");
  const cacheKey = "el:tts:" + createHash("sha256").update(sig).digest("hex");
  const cached = await getCache(cacheKey).catch(() => null);
  if (cached) return mp3(Buffer.from(cached, "base64"));

  const out = which === "minimax" ? await synthMiniMax(text, fast, emo) : await synthElevenLabs(text, fast, emo);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });

  await setCache(cacheKey, out.audio.toString("base64"), 30 * 24 * 3600).catch(() => {});
  return mp3(out.audio);
}

function mp3(buf: Buffer): Response {
  const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
  if (fast) return process.env.ELEVENLABS_FAST_MODEL || "eleven_v3_conversational";
  return process.env.ELEVENLABS_MODEL || "eleven_v3";
}

function mapEmotion(label?: string): string {
  const s = (label || "").trim();
  if (!s) return "";
  if (["tender","playful","jealous","heavy","serious","surprised"].includes(s)) return s;
  if (/(温柔|心疼|担心|在乎|想她|想你)/.test(s)) return "tender";
  if (/(开心|高兴|调皮|暗爽|得意|满足|兴奋|甜|乐)/.test(s)) return "playful";
  if (/(吃醋|占有|不爽|生气|恼|怒|嗔|管你)/.test(s)) return "jealous";
  if (/(难过|委屈|低落|失落|伤心|哭|沉|重)/.test(s)) return "heavy";
  if (/(认真|平静|正经|直接|严肃|淡)/.test(s)) return "serious";
  if (/(惊讶|惊喜|意外|吃惊)/.test(s)) return "surprised";
  return "";
}

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
  const s = elevenLabsSettings(emoOverride);
  return `${s.stability},${s.similarity_boost},${s.style}`;
}

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

function elevenLabsSettings(emo = "") {
  switch (emo) {
    case "tender":
      return { stability: 0.35, similarity_boost: 0.85, style: 0.50, speed: 1.05 };
    case "playful":
      return { stability: 0.22, similarity_boost: 0.80, style: 0.70, speed: 1.15 };
    case "jealous":
      return { stability: 0.18, similarity_boost: 0.78, style: 0.82, speed: 1.10 };
    case "heavy":
      return { stability: 0.40, similarity_boost: 0.88, style: 0.42, speed: 0.95 };
    case "serious":
      return { stability: 0.45, similarity_boost: 0.85, style: 0.35, speed: 1.08 };
    case "surprised":
      return { stability: 0.15, similarity_boost: 0.75, style: 0.72, speed: 1.15 };
    default:
      return { stability: 0.32, similarity_boost: 0.83, style: 0.45, speed: 1.05 };
  }
}

const EMO_VOICE: Record<string, string> = {
  tender:    "low, warm, slightly husky, intimate",
  playful:   "low, slightly amused, warm, light",
  jealous:   "low, intense, controlled, direct",
  heavy:     "husky, quiet, slow, weighted",
  serious:   "low, clear, steady, direct",
  surprised: "natural, slightly lighter",
};

async function rewriteForTTS(text: string, emo: string): Promise<string> {
  const voiceDesc = EMO_VOICE[emo] || "low, warm, calm";
  const prompt = `You are a voice markup assistant for ElevenLabs v3.

Voice style: ${voiceDesc}

Task: Add ElevenLabs v3 markup to the text below. Rules:
1. Start with ONE style tag on its own line: <adjective, adjective, ...> matching the voice style
2. Keep the original text EXACTLY as-is - do not rephrase, reorder, or change any words
3. Optionally insert ONE sound effect naturally within the text (not forced):
   [sighs]  [chuckles]  [inhales]  [exhales]
4. Do NOT add any Chinese annotations or any other extra markers
5. Output ONLY the marked-up text, nothing else

Text: ${text}`;

  try {
    const claude = getClaude();
    const res = await claude.messages.create({
      model: process.env.TTS_REWRITE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    } as any);
    const out = (res.content?.[0] as any)?.text?.trim();
    if (!out || /【|】/.test(out)) return text;
    return out;
  } catch {
    return text;
  }
}

async function synthElevenLabs(text: string, fast = false, emoOverride = ""): Promise<Synth> {
  const key = process.env.ELEVENLABS_API_KEY!;
  const voiceId = process.env.ELEVENLABS_VOICE_ID!;
  const model = modelOf("elevenlabs", fast);
  const emo = emoOverride || mapEmotion(process.env.MINIMAX_EMOTION || "") || "playful";
  const vs = elevenLabsSettings(emo);

  const finalText = fast ? text : await rewriteForTTS(text, emo);

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: finalText,
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
