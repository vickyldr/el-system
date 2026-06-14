import { NextResponse } from "next/server";

// 安卓网页蓝牙中继的同源代理：手机网页轮询这里，这里转发给 Railway bridge，
// 这样密钥留在服务端、也没有跨域问题。
export const runtime = "nodejs";

function bridge() {
  return (process.env.BRIDGE_URL || "").replace(/\/$/, "");
}
function secretHeaders(): Record<string, string> {
  const s = process.env.BRIDGE_SECRET || "";
  return s ? { "x-bridge-secret": s } : {};
}

// GET /api/toy-relay — 取下一条玩具指令（透传 bridge 的 /toy-next）
export async function GET() {
  const base = bridge();
  if (!base) return NextResponse.json({ error: "no bridge" }, { status: 503 });
  try {
    const r = await fetch(`${base}/toy-next`, {
      headers: secretHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return NextResponse.json({}, { status: 200 });
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data || {});
  } catch {
    return NextResponse.json({}, { status: 200 });
  }
}
