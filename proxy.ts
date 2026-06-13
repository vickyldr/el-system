import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 所有 /api/* 路由需要带 x-app-secret 头，防公网随意调用。
// Cron 路由例外：它们自己用 Authorization: Bearer CRON_SECRET 鉴权。
// Push subscription 例外：Service Worker 注册时不方便带自定义头。
export function proxy(req: NextRequest) {
  const secret = process.env.NEXT_PUBLIC_APP_SECRET;
  if (!secret) return NextResponse.next(); // 未配置就不拦（开发环境友好）

  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // 这些路由有自己的鉴权，跳过
  const exempt = ["/api/push/subscribe", "/api/cron/"];
  if (exempt.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = req.headers.get("x-app-secret");
  if (token !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
