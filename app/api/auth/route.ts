import { NextResponse } from "next/server";

export const runtime = "nodejs";

// app 启动时调用，验证 APP_SECRET 后种下 cookie，后续所有 API 请求凭 cookie 通过 proxy。
export async function POST(req: Request) {
  const secret = process.env.APP_SECRET;
  if (!secret) {
    // 未配置鉴权，直接放行
    return NextResponse.json({ ok: true });
  }
  let body: { secret?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (body.secret !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("app_token", secret, {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    maxAge: 60 * 60 * 24 * 365, // 1 年
    path: "/",
  });
  return res;
}
