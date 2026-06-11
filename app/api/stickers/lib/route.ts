import { NextResponse } from "next/server";
import { getStickerLib, removeStickerLib } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 共享表情库（你和 el 都能传、都能发）。
export async function GET() {
  return NextResponse.json({ stickers: await getStickerLib() });
}

// 删一张（重复上传 / 不想要了）。?id=xxx
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "缺 id" }, { status: 400 });
  await removeStickerLib(id);
  return NextResponse.json({ ok: true });
}
