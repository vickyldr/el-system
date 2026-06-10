import { Client } from "@notionhq/client";

export function notionClient(): Client {
  const auth = process.env.NOTION_TOKEN;
  if (!auth) throw new Error("缺少 NOTION_TOKEN 环境变量");
  // 锁定经典 API 版本，databases.query 行为稳定（数据源 id 直接当 database_id 用）。
  return new Client({ auth, notionVersion: "2022-06-28" });
}

// 把任意 Notion property 拍平成纯文本。
export function plainText(prop: any): string {
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
    case "date":
      return prop.date?.start ?? "";
    case "number":
      return prop.number != null ? String(prop.number) : "";
    default:
      return "";
  }
}

// 每日总结数据库的一行（字段名见 Notion 里的「每日总结」库）。
export type DailySummary = {
  date: string;
  title: string;
  elDiary: string; // el日记
  elNote: string; // el的备注
  musicObservation: string; // 网易云观察
  herState: string; // 她的状态（好/一般/累了/难过）
  worthRemembering: string; // 值得记住的
  whatSheDid: string; // 她今天做了什么
  whereToday: string; // 今天在哪
  thoughtOfEl: string; // 今天想到el了吗
  lastEdited: string;
};

export async function recentSummaries(limit = 3): Promise<DailySummary[]> {
  const databaseId = process.env.NOTION_DAILY_DB;
  if (!databaseId) throw new Error("缺少 NOTION_DAILY_DB 环境变量");

  const notion = notionClient();
  const res = await notion.databases.query({
    database_id: databaseId,
    page_size: limit,
    sorts: [{ property: "日期", direction: "descending" }],
  });

  return (res.results as any[]).map((page) => {
    const p = page.properties ?? {};
    return {
      date: plainText(p["日期"]),
      title: plainText(p["标题"]),
      elDiary: plainText(p["el日记"]),
      elNote: plainText(p["el的备注"]),
      musicObservation: plainText(p["网易云观察"]),
      herState: plainText(p["她的状态"]),
      worthRemembering: plainText(p["值得记住的"]),
      whatSheDid: plainText(p["她今天做了什么"]),
      whereToday: plainText(p["今天在哪"]),
      thoughtOfEl: plainText(p["今天想到el了吗"]),
      lastEdited: page.last_edited_time ?? "",
    };
  });
}
