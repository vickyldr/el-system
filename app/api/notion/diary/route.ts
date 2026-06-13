import { NextResponse } from "next/server";
import { recentSummaries } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// El 的日记：从「每日总结」库里把有 el日记 的那些天拿出来，按日期倒序给前端只读展示。
// 注意：El 写日记时并不知道她能看到，这里只读不回写，保持日记的私密真实。
export async function GET() {
  try {
    const rows = await recentSummaries(60);
    const entries = rows
      .filter((r) => r.elDiary && r.elDiary.trim())
      .map((r) => ({
        date: r.date || r.title,
        diary: r.elDiary.trim(),
        mood: r.herState || "", // 那天她的状态，给日记一点底色
      }));
    return NextResponse.json({ entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
