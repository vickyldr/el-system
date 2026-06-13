import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { putImage, addStickerLib } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 上传那一刻表情还是 base64，我（视觉）能直接看见它。
// 让我看一眼，自己写标签：既写画的是什么，也写什么情绪/什么时候发。
async function describeSticker(dataUrl: string): Promise<string> {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return "";
  try {
    const claude = getClaude();
    const model = process.env.CHEAP_MODEL || "claude-haiku-4-5-20251001"; // 给表情打标签，琐碎，用便宜的
    const res = await claude.messages.create({
      model,
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: m[1] as any, data: m[2] },
            },
            {
              type: "text",
              text:
                "这是要存进表情包库的一张表情/动图。用中文给它写一行标签，逗号分隔，包含两类词：" +
                "①画面里有什么（动物/人物/动作/物件）②什么情绪、什么场合会发它（比如 emo、发呆、想你、无语、撒娇、得意）。" +
                "只输出标签本身，别写别的。",
            },
          ],
        },
      ],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  } catch {
    return "";
  }
}

// 上传一张表情进共享库。body: { dataUrl, tags? }
// dataUrl 用 FileReader.readAsDataURL 出来的（保留 GIF 动图）。
// tags 可选：她想补一句就补；不补我自己看图写。
export async function POST(req: Request) {
  let body: { dataUrl?: string; tags?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const dataUrl = (body.dataUrl ?? "").trim();
  const note = (body.tags ?? "").trim();
  if (!/^data:image\//i.test(dataUrl)) {
    return NextResponse.json({ error: "要传一张图片" }, { status: 400 });
  }
  // base64 约 1.5MB → 原图约 1MB，够表情包用了
  if (dataUrl.length > 1.5 * 1024 * 1024) {
    return NextResponse.json({ error: "图片太大，压缩一下再传" }, { status: 400 });
  }
  // 我看一眼自动写的标签 + 她自己补的（如果有），合起来更准。
  const auto = await describeSticker(dataUrl);
  const tags = [note, auto].filter(Boolean).join("，") || "表情";

  const id = await putImage(dataUrl);
  if (!id) {
    return NextResponse.json({ error: "云存储没配好，存不了" }, { status: 500 });
  }
  const sticker = { id, img: `/api/img/${id}`, tags };
  await addStickerLib(sticker);
  return NextResponse.json({ ok: true, sticker });
}
