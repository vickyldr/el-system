import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// API 鉴权：用 cookie 而不是打包时烧进去的变量，避免 build 时序问题。
// APP_SECRET 是纯服务端变量（不带 NEXT_PUBLIC_ 前缀），运行时读取。
export function proxy(req: NextRequest) {
  const secret = process.env.APP_SECRET;
  if (!secret) return NextResponse.next(); // 未配置就不拦

  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // 这些路由有自己的鉴权或不需要保护
  const exempt = ["/api/push/subscribe", "/api/cron/", "/api/auth"];
  if (exempt.some((p) => pathname.startsWith(p))) return NextResponse.next();

  // 检查 cookie（PWA 登录后种下）
  const cookie = req.cookies.get("app_token")?.value;
  if (cookie === secret) return NextResponse.next();

  // 也允许 header 方式（兼容 bridge 内部调用）
  const header = req.headers.get("x-app-secret");
  if (header === secret) return NextResponse.next();

  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const config = {
  matcher: "/api/:path*",
};
