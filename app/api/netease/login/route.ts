import { NextResponse } from "next/server";
import { qrKey, qrImageUrl, qrCheck } from "@/lib/netease-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 无 key：生成一个登录二维码。带 ?key=：轮询扫码状态（803=成功，cookie 已存服务端）。
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (key) {
    const r = await qrCheck(key).catch(() => ({ code: 0 }));
    return NextResponse.json(r);
  }
  const k = await qrKey().catch(() => "");
  if (!k) return NextResponse.json({ error: "拿不到二维码，等下再试" }, { status: 502 });
  return NextResponse.json({ key: k, qr: qrImageUrl(k) });
}
