import { NextResponse } from "next/server";
import { qrKey, qrImageUrl, qrCheck } from "@/lib/netease-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 无 key：生成一个登录二维码。带 ?key=：轮询扫码状态（803=成功，cookie 已存服务端）。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const ip = url.searchParams.get("ip") || undefined; // 临时换 IP 测试用
  if (key) {
    const r = await qrCheck(key, ip).catch(() => ({ code: 0 }));
    return NextResponse.json(r);
  }
  const k = await qrKey(ip).catch((e) => ({ unikey: "", message: String(e?.message || e) }) as any);
  if (!k.unikey)
    return NextResponse.json(
      { error: "拿不到二维码", detail: `code=${k.code ?? "?"} ${k.message ?? ""}` },
      { status: 502 },
    );
  return NextResponse.json({ key: k.unikey, qr: qrImageUrl(k.unikey) });
}
