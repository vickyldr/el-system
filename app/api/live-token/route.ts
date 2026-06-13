import { NextResponse } from "next/server";

export const runtime = "nodejs";

// 返回 Gemini Live WebSocket 连接凭证（只对已鉴权用户开放，由 proxy 中间件保护）。
export async function GET() {
  const bridgeUrl = process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET || "";

  if (!bridgeUrl) {
    return NextResponse.json({ error: "bridge not configured" }, { status: 503 });
  }

  // http → ws，https → wss
  const wsUrl = bridgeUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(/\/$/, "");

  return NextResponse.json({ wsUrl, secret });
}
