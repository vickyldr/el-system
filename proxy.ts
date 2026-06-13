import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ⚠️ 鉴权暂时关闭（fail-open）。
// 原因：前端从未调用 /api/auth 去种 app_token cookie（没有登录界面），
// 所以一旦在 Vercel 设了 APP_SECRET，proxy 中间件会把【所有】/api/* 请求挡成 401，
// 整个 app（此刻/Notion/聊天/语音 token）直接瘫痪。
// 在补上"前端登录流程"之前，这里一律放行，保证 app 能正常用。
// 想重新开启鉴权：先做一个登录页 + 调 /api/auth，再恢复下面注释掉的逻辑。
export function proxy(_req: NextRequest) {
  return NextResponse.next();

  /* —— 原鉴权逻辑（缺前端登录，先停用）——
  const secret = process.env.APP_SECRET;
  if (!secret) return NextResponse.next();
  const { pathname } = _req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  const exempt = ["/api/push/subscribe", "/api/cron/", "/api/auth"];
  if (exempt.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const cookie = _req.cookies.get("app_token")?.value;
  if (cookie === secret) return NextResponse.next();
  const header = _req.headers.get("x-app-secret");
  if (header === secret) return NextResponse.next();
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  */
}

export const config = {
  matcher: "/api/:path*",
};
