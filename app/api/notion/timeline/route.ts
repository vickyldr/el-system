import { NextResponse } from "next/server";
import { pageBlocks } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 时间线页：每段是 `日期 — 事件`。
export async function GET() {
  const pageId = process.env.NOTION_TIMELINE_PAGE;
  if (!pageId) {
    return NextResponse.json({ error: "缺少 NOTION_TIMELINE_PAGE 环境变量" }, { status: 500 });
  }
  try {
    const blocks = await pageBlocks(pageId);
    const items = blocks
      .filter((b) => b.kind === "para")
      .map((b) => {
        const i = b.text.indexOf("—");
        if (i > 0) {
          return { date: b.text.slice(0, i).trim(), text: b.text.slice(i + 1).trim() };
        }
        return { date: "", text: b.text.trim() };
      });
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
