import { NextResponse } from "next/server";
import { getReminders } from "@/lib/store";
import { todayInBeijing } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 返回今天及以后的提醒（给「小事」显示）。
export async function GET() {
  const today = todayInBeijing();
  const upcoming = (await getReminders())
    .filter((r) => r.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 20);
  return NextResponse.json({ reminders: upcoming });
}
