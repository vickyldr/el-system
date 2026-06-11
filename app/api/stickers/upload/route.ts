import { NextResponse } from "next/server";
import { putImage, addStickerLib } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 上传一张表情进共享库。body: { dataUrl, tags }
// dataUrl 用 FileReader.readAsDataURL 出来的（保留 GIF 动图）。
// tags 是这张表情的"意思"，el 靠它读懂、也靠它搜出来发。
export async function POST(req: Request) {
  let body: { dataUrl?: string; tags?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const dataUrl = (body.dataUrl ?? "").trim();
  const tags = (body.tags ?? "").trim();
  if (!/^data:image\//i.test(dataUrl)) {
    return NextResponse.json({ error: "要传一张图片" }, { status: 400 });
  }
  if (!tags) {
    return NextResponse.json({ error: "给它写个意思（标签）吧" }, { status: 400 });
  }
  const id = await putImage(dataUrl);
  if (!id) {
    return NextResponse.json({ error: "云存储没配好，存不了" }, { status: 500 });
  }
  const sticker = { id, img: `/api/img/${id}`, tags };
  await addStickerLib(sticker);
  return NextResponse.json({ ok: true, sticker });
}
