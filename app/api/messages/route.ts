import { NextResponse } from "next/server";
import { getStoredMessages, storeAvailable, clearMessages } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 返回云端存的整段对话（没配 KV 时 cloud=false，前端回落到本地）。
export async function GET() {
  return NextResponse.json({
    cloud: storeAvailable(),
    messages: await getStoredMessages(),
  });
}

// 清空云端对话。
export async function DELETE() {
  await clearMessages();
  return NextResponse.json({ ok: true });
}
