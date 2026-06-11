import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 配好没（前端用来决定要不要显示「听」按钮）。
export async function GET() {
  const configured = !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
  return NextResponse.json({ configured });
}

// 把一段文字用 el 的音色念出来（ElevenLabs），返回 mp3。
export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) {
    return NextResponse.json({ error: "语音还没配置（缺 ElevenLabs key / voice id）" }, { status: 503 });
  }

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").trim().slice(0, 600); // 限长，省额度
  if (!text) return NextResponse.json({ error: "没内容可念" }, { status: 400 });

  // 默认 turbo（支持中文、半价省额度）；想更高质量可在环境变量换 eleven_multilingual_v2。
  const model = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json(
        { error: `语音生成失败（${r.status}）`, detail: detail.slice(0, 200) },
        { status: 502 },
      );
    }
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "语音服务连不上" }, { status: 502 });
  }
}
