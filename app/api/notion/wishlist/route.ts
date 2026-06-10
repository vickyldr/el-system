import { NextResponse } from "next/server";
import { pageBlocks } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Group = { title: string; items: { text: string; done: boolean }[] };

// 愿望墙页：`# 分组` 下若干 bullet，删除线 = 已实现。
export async function GET() {
  const pageId = process.env.NOTION_WISHLIST_PAGE;
  if (!pageId) {
    return NextResponse.json({ error: "缺少 NOTION_WISHLIST_PAGE 环境变量" }, { status: 500 });
  }
  try {
    const blocks = await pageBlocks(pageId);
    const groups: Group[] = [];
    let cur: Group | null = null;
    for (const b of blocks) {
      if (b.kind === "heading") {
        cur = { title: b.text, items: [] };
        groups.push(cur);
      } else if (b.kind === "bullet" || b.kind === "todo") {
        if (!cur) {
          cur = { title: "", items: [] };
          groups.push(cur);
        }
        cur.items.push({ text: b.text, done: !!b.struck || !!b.checked });
      }
    }
    return NextResponse.json({ groups });
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
