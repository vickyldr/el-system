import { NextResponse } from "next/server";
import { getStoredMessages, storeAvailable } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 返回云端存的整段对话（没配 KV 时 cloud=false，前端回落到本地）。
export async function GET() {
  return NextResponse.json({
    cloud: storeAvailable(),
    messages: await getStoredMessages(),
  });
}
