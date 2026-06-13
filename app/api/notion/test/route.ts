import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = process.env.NOTION_TOKEN ?? "(not set)";
  const timelinePage = process.env.NOTION_TIMELINE_PAGE ?? "(not set)";

  // 直接用 fetch 测试，绕过 SDK
  let notionResult: unknown = null;
  try {
    const r = await fetch("https://api.notion.com/v1/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    });
    notionResult = await r.json();
  } catch (e) {
    notionResult = { fetchError: String(e) };
  }

  return NextResponse.json({
    tokenPrefix: token.slice(0, 12) + "...",
    timelinePage,
    notion: notionResult,
  });
}
