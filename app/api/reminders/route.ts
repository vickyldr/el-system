import { NextResponse } from "next/server";
import { getReminders, setReminders } from "@/lib/store";
import { todayInBeijing } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const today = todayInBeijing();
  const upcoming = (await getReminders())
    .filter((r) => r.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 20);
  return NextResponse.json({ reminders: upcoming });
}

// DELETE /api/reminders  body: { id } 删单条，或 { all: true } 清空
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  const list = await getReminders();
  const next = body.all ? [] : list.filter((r) => r.id !== body.id);
  await setReminders(next);
  return NextResponse.json({ ok: true, remaining: next.length });
}
