import { NextResponse } from "next/server";
import { notionClient } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = process.env.NOTION_TOKEN;
  const timelinePage = process.env.NOTION_TIMELINE_PAGE;
  if (!token) return NextResponse.json({ error: "NOTION_TOKEN 未设置" });

  try {
    const notion = notionClient();
    const me = await notion.users.me({});
    return NextResponse.json({
      ok: true,
      bot: me.name,
      tokenPrefix: token.slice(0, 10) + "...",
      timelinePage,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      tokenPrefix: token.slice(0, 10) + "...",
      timelinePage,
    });
  }
}
