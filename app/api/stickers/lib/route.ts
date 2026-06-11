import { NextResponse } from "next/server";
import { getStickerLib } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 共享表情库（你和 el 都能传、都能发）。
export async function GET() {
  return NextResponse.json({ stickers: await getStickerLib() });
}
