import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 电影推荐已停用：豆瓣账号被风控 ban，所有自动/手动访问豆瓣都关掉，避免再触发风控。
// 前端「电影」屏已移除；此路由保留为安全空壳，不再 import / 调用 douban。
export async function GET() {
  return NextResponse.json({ movie: null, disabled: true });
}

export async function POST() {
  return NextResponse.json({ movie: null, disabled: true });
}
