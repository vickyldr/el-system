import { NextResponse } from "next/server";
import { setNeteaseCookie } from "@/lib/netease-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}) as any);
  const cookie = String(body?.cookie || "").trim();
  if (!cookie || !/MUSIC_U=/.test(cookie)) {
    return NextResponse.json({ ok: false, error: "cookie 里必须含 MUSIC_U=..." });
  }
  const r = await setNeteaseCookie(cookie).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
  return NextResponse.json(r);
}
