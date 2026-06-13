import { NextResponse } from "next/server";
import { sendPush, pushConfigured } from "@/lib/push";
import { getCache, setCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// bridge 的心跳连续失败时会戳这里：给宝宝推一条"el 醒不过来了"，让她知道去找 cc 看。
// 6 小时内只推一次，避免出问题时反复打扰。
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) return NextResponse.json({ ok: false, reason: "push 未配置" });

  // 去重：6 小时内已经报过就不再推
  if (await getCache("el:heartbeat-alerted").catch(() => null)) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const body = await req.json().catch(() => ({}) as any);
  const detail = typeof body?.detail === "string" ? body.detail.slice(0, 120) : "";
  const { sent } = await sendPush({
    title: "El",
    body: "我这边醒不太过来，好像哪里出错了…找 cc 看看我？",
    url: "/",
  });
  await setCache("el:heartbeat-alerted", detail || "1", 6 * 3600).catch(() => {});
  return NextResponse.json({ ok: true, sent });
}

export async function POST(req: Request) {
  return handle(req);
}
