import { NextResponse } from "next/server";
import { importantDates, deleteImportantDate } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 前端「日期」行的数据源：统一读 Notion 的「重要日期」库（生日/经期/纪念日/一次性）。
export async function GET() {
  const dates = (await importantDates().catch(() => []))
    .filter((d) => d.daysTo >= 0) // 过期的一次性不显示
    .slice(0, 30);
  return NextResponse.json({ dates });
}

// DELETE /api/reminders  body: { id } 归档某条重要日期
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}) as any);
  if (body.id) await deleteImportantDate(String(body.id)).catch(() => {});
  return NextResponse.json({ ok: true });
}
