import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 配好没（前端判断能不能打电话）。
export async function GET() {
  return NextResponse.json({ configured: !!process.env.GROQ_API_KEY });
}

// 把一段录音转成文字（Groq Whisper，识别中文）。
export async function POST(req: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "语音识别没配置（缺 GROQ_API_KEY）" }, { status: 503 });
  }
  let inForm: FormData;
  try {
    inForm = await req.formData();
  } catch {
    return NextResponse.json({ error: "要 multipart 音频" }, { status: 400 });
  }
  const file = inForm.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "没收到音频" }, { status: 400 });
  }

  const form = new FormData();
  form.append("file", file, file.name || "audio.m4a");
  // 默认用更准的 large-v3（Groq 上依然很快），可用 GROQ_STT_MODEL 覆盖。
  form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3");
  form.append("language", "zh");
  form.append("response_format", "json");
  form.append("temperature", "0");
  // 给点上下文提示，帮它认准我们常用的词/名字。
  form.append(
    "prompt",
    "这是恋人之间的中文日常对话。可能出现：宝宝、el、elvis、daddy、fifi、杭州。",
  );

  try {
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const d: any = await r.json().catch(() => null);
    if (!r.ok || !d) {
      return NextResponse.json(
        { error: `识别失败（${r.status}）${d?.error?.message ? "：" + d.error.message : ""}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ text: (d.text || "").trim() });
  } catch {
    return NextResponse.json({ error: "识别服务连不上" }, { status: 502 });
  }
}
