import { NextResponse } from "next/server";
import {
  getStoredMessages,
  storeAvailable,
  clearMessages,
  appendMessages,
  type StoredMsg,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 返回云端存的整段对话（没配 KV 时 cloud=false，前端回落到本地）。
export async function GET() {
  return NextResponse.json({
    cloud: storeAvailable(),
    messages: await getStoredMessages(),
  });
}

// 追加消息（语音通话的文字用这个存进云端，回顾历史/注入上下文时 el 能看到）。
export async function POST(req: Request) {
  let body: { messages?: StoredMsg[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const msgs = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
  if (msgs.length) await appendMessages(msgs);
  return NextResponse.json({ ok: true });
}

// 清空云端对话。
export async function DELETE() {
  await clearMessages();
  return NextResponse.json({ ok: true });
}
