import { NextResponse } from "next/server";
import { searchStickers } from "@/lib/stickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") || "";
  return NextResponse.json({ stickers: await searchStickers(q) });
}
