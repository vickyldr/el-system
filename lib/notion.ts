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
  now: string; // 此刻（cron 生成的当下状态）
  elDiary: string; // el日记
  elNote: string; // el的备注
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
      now: plainText(p["此刻"]),
      elDiary: plainText(p["el日记"]),
      elNote: plainText(p["el的备注"]),
      herState: plainText(p["她的状态"]),
      worthRemembering: plainText(p["值得记住的"]),
      whatSheDid: plainText(p["她今天做了什么"]),
      whereToday: plainText(p["今天在哪"]),
      thoughtOfEl: plainText(p["今天想到el了吗"]),
      lastEdited: page.last_edited_time ?? "",
    };
  });
}

// ── 读取普通页面的内容（时间线 / 愿望墙 / 人物档案都是页面，不是数据库）──

export type NBlock = {
  kind: "heading" | "para" | "bullet" | "todo" | "quote";
  text: string;
  checked?: boolean; // to_do 勾选
  struck?: boolean; // 整行删除线（愿望墙里 = 已实现）
};

function richText(arr: any[]): { text: string; struck: boolean } {
  const a = arr ?? [];
  const text = a.map((t: any) => t.plain_text).join("");
  const struck = a.length > 0 && a.every((t: any) => t.annotations?.strikethrough);
  return { text, struck };
}

// 读一页的顶层 block，拍平成 NBlock[]（不递归嵌套子块）。
export async function pageBlocks(pageId: string): Promise<NBlock[]> {
  const notion = notionClient();
  const out: NBlock[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results as any[]) {
      const t = b.type as string;
      const data = b[t];
      if (!data) continue;
      if (t === "divider") continue;
      if (t.startsWith("heading_")) {
        const { text } = richText(data.rich_text);
        if (text.trim()) out.push({ kind: "heading", text });
      } else if (t === "paragraph") {
        const { text } = richText(data.rich_text);
        if (text.trim()) out.push({ kind: "para", text });
      } else if (t === "bulleted_list_item" || t === "numbered_list_item") {
        const { text, struck } = richText(data.rich_text);
        if (text.trim()) out.push({ kind: "bullet", text, struck });
      } else if (t === "to_do") {
        const { text, struck } = richText(data.rich_text);
        if (text.trim()) out.push({ kind: "todo", text, checked: !!data.checked, struck });
      } else if (t === "quote") {
        const { text } = richText(data.rich_text);
        if (text.trim()) out.push({ kind: "quote", text });
      }
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

// 把一页拍平成纯文本（给 El 当记忆上下文用）。
export async function pageText(pageId: string): Promise<string> {
  const blocks = await pageBlocks(pageId);
  return blocks
    .map((b) =>
      b.kind === "heading"
        ? `\n# ${b.text}`
        : b.kind === "bullet" || b.kind === "todo"
          ? `- ${b.text}`
          : b.text,
    )
    .join("\n")
    .trim();
}

// 北京时间今天的日期 YYYY-MM-DD
export function todayInBeijing(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

// 更新某一天「每日总结」行的字段（没有那天的行就新建）。只写传入的字段，不动别的。
export async function updateDailyFields(
  fields: Record<string, string>,
  date: string = todayInBeijing(),
): Promise<void> {
  const databaseId = process.env.NOTION_DAILY_DB;
  if (!databaseId) throw new Error("缺少 NOTION_DAILY_DB 环境变量");
  const notion = notionClient();

  const props: any = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    if (k === "她的状态") props[k] = { select: { name: v } };
    else props[k] = { rich_text: [{ type: "text", text: { content: v.slice(0, 1900) } }] };
  }
  if (!Object.keys(props).length) return;

  const res: any = await notion.databases.query({
    database_id: databaseId,
    page_size: 1,
    filter: { property: "日期", date: { equals: date } },
  } as any);

  if (res.results.length) {
    await notion.pages.update({ page_id: res.results[0].id, properties: props } as any);
  } else {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        标题: { title: [{ type: "text", text: { content: date } }] },
        日期: { date: { start: date } },
        ...props,
      },
    } as any);
  }
}

// 把「此刻」写进今天那行。
export async function writeNow(text: string): Promise<void> {
  await updateDailyFields({ 此刻: text });
}

// 往一页末尾追加段落（长期记忆 / 时间线等）。只追加，不删旧的。
export async function appendToPage(pageId: string, lines: string[]): Promise<void> {
  const notion = notionClient();
  const children = lines
    .filter((t) => t && t.trim())
    .map((t) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: t.slice(0, 1900) } }] },
    }));
  if (!children.length) return;
  await notion.blocks.children.append({ block_id: pageId, children } as any);
}

// 列出「小家」父页下的所有子页 / 子库，给 El 的按需读取工具用。
// layer：跟着首页里的「## 记忆层 / ## 工具层」标题走——记忆层进上下文，工具层只按需读。
// 这样宝宝在 Notion 里怎么挪页、加页，代码自动跟着变，不用改环境变量。
export type HomeChild = {
  title: string;
  id: string;
  type: "page" | "database";
  layer: "memory" | "tool";
};
export async function homeChildren(): Promise<HomeChild[]> {
  const home = process.env.NOTION_HOME_PAGE;
  if (!home) return [];
  const notion = notionClient();
  const out: HomeChild[] = [];
  let layer: "memory" | "tool" = "memory"; // 第一个标题之前默认算记忆层
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: home,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results as any[]) {
      if (b.type === "heading_1" || b.type === "heading_2" || b.type === "heading_3") {
        const t = (b[b.type]?.rich_text ?? []).map((x: any) => x.plain_text).join("");
        if (t.includes("工具")) layer = "tool";
        else if (t.includes("记忆")) layer = "memory";
      } else if (b.type === "child_page") {
        out.push({ title: b.child_page?.title ?? "", id: b.id, type: "page", layer });
      } else if (b.type === "child_database") {
        out.push({ title: b.child_database?.title ?? "", id: b.id, type: "database", layer });
      }
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

// ── 重要日期（数据库）：生日/经期/纪念日/一次性。前端、推送、add_reminder 的唯一源。──
export type ImportantDate = {
  id: string;
  name: string;
  date: string; // 参照日 YYYY-MM-DD
  recur: string; // 每年 / 每月 / 一次
  leadDays: number; // 提前提醒（天）
  note: string;
  daysTo: number; // 距「下一次」还有几天（一次性过期则为负）
  nextDate: string; // 下一次发生的具体日期
};

function ymd(s: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((s || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function diffDays(aY: number, aM: number, aD: number, bY: number, bM: number, bD: number): number {
  return Math.round((Date.UTC(aY, aM - 1, aD) - Date.UTC(bY, bM - 1, bD)) / 86400000);
}
// 把"号"夹到当月最大天数（处理 31 号落到 2 月这种）。m 为 1-based。
function clampDay(y: number, m: number, d: number): number {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(d, last);
}
const fmtYmd = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// 按「循环」算下一次发生：每年看月日，每月看号，一次看原日期。
function nextOccurrence(refDate: string, recur: string, today: string): { daysTo: number; nextDate: string } {
  const r = ymd(refDate);
  const t = ymd(today);
  if (!r || !t) return { daysTo: 9999, nextDate: refDate };
  const [, rm, rd] = r;
  const [ty, tm, td] = t;
  if (recur === "每年") {
    let y = ty;
    let d = clampDay(y, rm, rd);
    if (diffDays(y, rm, d, ty, tm, td) < 0) {
      y = ty + 1;
      d = clampDay(y, rm, rd);
    }
    return { daysTo: diffDays(y, rm, d, ty, tm, td), nextDate: fmtYmd(y, rm, d) };
  }
  if (recur === "每月") {
    let y = ty;
    let m = tm;
    let d = clampDay(y, m, rd);
    if (diffDays(y, m, d, ty, tm, td) < 0) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      d = clampDay(y, m, rd);
    }
    return { daysTo: diffDays(y, m, d, ty, tm, td), nextDate: fmtYmd(y, m, d) };
  }
  // 一次
  const [ry, rmm, rdd] = r;
  return { daysTo: diffDays(ry, rmm, rdd, ty, tm, td), nextDate: refDate };
}

// 找「重要日期」库（首页里那张），算出每条"下一次还有几天"，按近到远排。
export async function importantDates(): Promise<ImportantDate[]> {
  const children = await homeChildren();
  const db = children.find(
    (c) => c.type === "database" && c.title.replace(/\s/g, "").includes("重要日期"),
  );
  if (!db) return [];
  const notion = notionClient();
  let rows: any[] = [];
  try {
    const res = await notion.databases.query({ database_id: db.id, page_size: 100 });
    rows = res.results as any[];
  } catch {
    return [];
  }
  const today = todayInBeijing();
  const out: ImportantDate[] = [];
  for (const page of rows) {
    const p = page.properties ?? {};
    const name = plainText(p["名称"]);
    const date = plainText(p["日期"]);
    if (!name || !date) continue;
    const recur = plainText(p["循环"]) || "一次";
    const leadNum = Number(plainText(p["提前提醒"]));
    const leadDays = Number.isFinite(leadNum) && leadNum > 0 ? leadNum : 3;
    const { daysTo, nextDate } = nextOccurrence(date, recur, today);
    out.push({ id: page.id, name, date, recur, leadDays, note: plainText(p["备注"]), daysTo, nextDate });
  }
  return out.sort((a, b) => a.daysTo - b.daysTo);
}

// 往「重要日期」加一行（el 的 add_reminder 走这）。返回是否成功。
export async function addImportantDate(
  name: string,
  date: string,
  recur = "一次",
  leadDays = 3,
): Promise<boolean> {
  const children = await homeChildren();
  const db = children.find(
    (c) => c.type === "database" && c.title.replace(/\s/g, "").includes("重要日期"),
  );
  if (!db) return false;
  const notion = notionClient();
  await notion.pages.create({
    parent: { database_id: db.id },
    properties: {
      名称: { title: [{ text: { content: name } }] },
      日期: { date: { start: date } },
      循环: { select: { name: recur } },
      提前提醒: { number: leadDays },
    } as any,
  });
  return true;
}

// 归档（删除）一条重要日期。
export async function deleteImportantDate(pageId: string): Promise<void> {
  const notion = notionClient();
  await notion.pages.update({ page_id: pageId, archived: true } as any);
}
