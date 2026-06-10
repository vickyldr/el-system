import { NextResponse } from "next/server";
import { pageBlocks } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Section = { title: string; lines: string[] };

// 人物档案页：`# 分区`（宝宝/el/发小/Fifi）下若干行。这是 El 记着大家的地方。
export async function GET() {
  const pageId = process.env.NOTION_MEMORY_PAGE;
  if (!pageId) {
    return NextResponse.json({ error: "缺少 NOTION_MEMORY_PAGE 环境变量" }, { status: 500 });
  }
  try {
    const blocks = await pageBlocks(pageId);
    const sections: Section[] = [];
    let cur: Section | null = null;
    for (const b of blocks) {
      if (b.kind === "heading") {
        cur = { title: b.text, lines: [] };
        sections.push(cur);
      } else {
        if (!cur) {
          cur = { title: "", lines: [] };
          sections.push(cur);
        }
        const prefix = b.kind === "bullet" || b.kind === "todo" ? "· " : "";
        cur.lines.push(prefix + b.text);
      }
    }
    return NextResponse.json({ sections });
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
