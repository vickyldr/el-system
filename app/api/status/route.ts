import { Client } from "@notionhq/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// 不缓存，每次都读最新状态
export const dynamic = "force-dynamic";

// 把一个 Notion property 拍平成纯文本，尽量兼容各种属性类型。
function readProperty(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
      return (prop.title ?? []).map((t: any) => t.plain_text).join("").trim();
    case "rich_text":
      return (prop.rich_text ?? []).map((t: any) => t.plain_text).join("").trim();
    case "select":
      return prop.select?.name ?? "";
    case "status":
      return prop.status?.name ?? "";
    case "multi_select":
      return (prop.multi_select ?? []).map((s: any) => s.name).join(", ");
    case "number":
      return prop.number != null ? String(prop.number) : "";
    case "url":
      return prop.url ?? "";
    case "date":
      return prop.date?.start ?? "";
    case "formula":
      return prop.formula?.string ?? (prop.formula?.number != null ? String(prop.formula.number) : "");
    case "people":
      return (prop.people ?? []).map((p: any) => p.name).join(", ");
    default:
      return "";
  }
}

// 在一条记录的 properties 里，按候选名（中英文都试）找出第一个有值的属性。
function pick(properties: Record<string, any>, candidates: string[]): string {
  for (const name of candidates) {
    const match = Object.keys(properties).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (match) {
      const value = readProperty(properties[match]);
      if (value) return value;
    }
  }
  return "";
}

export async function GET() {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!token) {
    return NextResponse.json(
      { error: "缺少 NOTION_TOKEN 环境变量" },
      { status: 500 },
    );
  }
  if (!databaseId) {
    return NextResponse.json(
      { error: "缺少 NOTION_DATABASE_ID 环境变量" },
      { status: 500 },
    );
  }

  const notion = new Client({ auth: token });

  try {
    // 读取数据库里最新编辑的一条记录作为「当前状态」
    const res = await notion.databases.query({
      database_id: databaseId,
      page_size: 1,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });

    const page: any = res.results[0];
    if (!page) {
      return NextResponse.json({ mood: "", song: "", weather: "", updatedAt: null });
    }

    const properties = page.properties ?? {};

    return NextResponse.json({
      mood: pick(properties, ["心情", "mood"]),
      song: pick(properties, ["在听什么歌", "歌", "song", "music", "听歌"]),
      weather: pick(properties, ["天气", "weather"]),
      updatedAt: page.last_edited_time ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
