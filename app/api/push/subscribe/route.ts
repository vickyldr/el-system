import { NextResponse } from "next/server";
import { addPushSub } from "@/lib/store";
import { sendPush } from "@/lib/push";

export const runtime = "nodejs";

// 保存这台设备的推送订阅。welcome=true 时发一条欢迎推送确认通道通了。
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const sub = body?.subscription ?? body;
  if (!sub?.endpoint) {
    return NextResponse.json({ error: "no subscription" }, { status: 400 });
  }
  await addPushSub(sub);
  if (body?.welcome) {
    await sendPush({ title: "El", body: "通知开好了，我在了。", url: "/" }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
