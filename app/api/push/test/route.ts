import { NextResponse } from "next/server";
import { sendPush, pushConfigured } from "@/lib/push";

export const runtime = "nodejs";

// 手机点铃铛时调这个：给已订阅的设备发一条测试推送，确认通道通不通。
export async function POST() {
  if (!pushConfigured()) return NextResponse.json({ ok: false, reason: "no-vapid", sent: 0 });
  const { sent } = await sendPush({
    title: "El",
    body: "测试推送～能看到我，就说明通道是好的 💛",
    url: "/",
  });
  return NextResponse.json({ ok: true, sent });
}
