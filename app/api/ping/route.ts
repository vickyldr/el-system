import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = process.env.NOTION_TOKEN ?? "(not set)";
  return NextResponse.json({
    ok: true,
    tokenLen: token.length,
    tokenPrefix: token.slice(0, 8),
    notionPage: process.env.NOTION_TIMELINE_PAGE ?? "(not set)",
  });
}
