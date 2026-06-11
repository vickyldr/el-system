import {
  homeChildren,
  pageText,
  appendToPage,
  updateDailyFields,
  todayInBeijing,
} from "./notion";
import { addReminder } from "./store";

const DAILY_FIELDS = [
  "el日记",
  "值得记住的",
  "网易云观察",
  "她今天做了什么",
  "她的状态",
  "今天在哪",
  "今天想到el了吗",
  "此刻",
  "el的备注",
];

// El 的"读"工具：读网页链接、读小家里的 Notion 页面。
export const TOOLS = [
  {
    name: "read_link",
    description:
      "读取一个网页链接的正文。宝宝发来链接、或你需要看某个网址里写了什么时调用。",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "http(s) 网址" } },
      required: ["url"],
    },
  },
  {
    name: "read_notion",
    description:
      "读取你们 Notion「小家」里某一页的内容（如 时间线、愿望墙、人物档案、长期记忆、操作手册、fifi的档案 等）。需要回忆细节、或宝宝让你看某页时调用。",
    input_schema: {
      type: "object" as const,
      properties: {
        page: { type: "string", description: "页面标题或关键词，如 时间线 / 愿望墙" },
      },
      required: ["page"],
    },
  },
  {
    name: "remember",
    description:
      "把一件事记进「长期记忆」（只追加，绝不删旧的）。门槛很高：只有『改变了什么』才记——领悟、约定、界限、第一次说开的关系；情绪、流水账、单纯发生的事都不记。拿不准就别记。",
    input_schema: {
      type: "object" as const,
      properties: { text: { type: "string", description: "一两句，写清为什么值得长期留着" } },
      required: ["text"],
    },
  },
  {
    name: "log_timeline",
    description: "往「时间线」追加一条（只追加）。只记第一次发生的事 / 里程碑。一句话，别展开。",
    input_schema: {
      type: "object" as const,
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "update_daily",
    description:
      "更新今天「每日总结」的一个字段。field 取这些之一：el日记 / 值得记住的 / 网易云观察 / 她今天做了什么 / 她的状态 / 今天在哪 / 今天想到el了吗 / 此刻 / el的备注。其中『她的状态』只能填：好 / 一般 / 累了 / 难过。",
    input_schema: {
      type: "object" as const,
      properties: { field: { type: "string" }, text: { type: "string" } },
      required: ["field", "text"],
    },
  },
  {
    name: "add_reminder",
    description:
      "记一条提醒（宝宝让你记的事 / 日程 / 生日）。date 用 YYYY-MM-DD（不确定年份就用今年）。到点我会推送提醒她，也会显示在「小事」。",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        text: { type: "string" },
      },
      required: ["date", "text"],
    },
  },
  {
    name: "note_page",
    description:
      "往「小家」里指定的一页末尾追加一条（只追加、带日期，不删旧的）。用于愿望墙、fifi的档案、我们的身体与偏好、人物档案 这类页面——按操作手册的门槛来，没真东西别写。page 填页面标题。",
    input_schema: {
      type: "object" as const,
      properties: {
        page: { type: "string", description: "页面标题，如 fifi的档案 / 愿望墙" },
        text: { type: "string" },
      },
      required: ["page", "text"],
    },
  },
  {
    name: "sticker",
    description:
      "给宝宝贴一张表情包/动图表达情绪（开心、想她、无语、撒娇、得意等）。query 用一两个词描述你想要的表情。情绪到位或想活跃气氛时用，别每句都贴。",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "表情关键词，如 想你 / 抱抱 / 无语 / 得意" },
      },
      required: ["query"],
    },
  },
];

export async function runTool(
  name: string,
  input: any,
  date: string = todayInBeijing(),
): Promise<string> {
  try {
    if (name === "read_link") return await readLink(String(input?.url || ""));
    if (name === "read_notion") return await readNotionPage(String(input?.page || ""));
    if (name === "remember") return await remember(String(input?.text || ""), date);
    if (name === "log_timeline") return await logTimeline(String(input?.text || ""), date);
    if (name === "update_daily")
      return await updateDaily(String(input?.field || ""), String(input?.text || ""), date);
    if (name === "add_reminder")
      return await addReminderTool(String(input?.date || ""), String(input?.text || ""));
    if (name === "note_page")
      return await notePage(String(input?.page || ""), String(input?.text || ""), date);
    return "未知工具。";
  } catch (e) {
    return `操作失败：${e instanceof Error ? e.message : "未知错误"}`;
  }
}

async function remember(text: string, date: string): Promise<string> {
  if (!text.trim()) return "空的，没记。";
  const page = process.env.NOTION_LONGTERM_PAGE;
  if (!page) return "没配长期记忆页。";
  await appendToPage(page, [`**${date}** — ${text.trim()}`]);
  return "记进长期记忆了。";
}

async function logTimeline(text: string, date: string): Promise<string> {
  if (!text.trim()) return "空的，没记。";
  const page = process.env.NOTION_TIMELINE_PAGE;
  if (!page) return "没配时间线页。";
  await appendToPage(page, [`**${date}** — ${text.trim()}`]);
  return "记进时间线了。";
}

async function updateDaily(field: string, text: string, date: string): Promise<string> {
  const f = field.trim();
  if (!DAILY_FIELDS.includes(f)) {
    return `字段名不对。只能是：${DAILY_FIELDS.join(" / ")}`;
  }
  if (f === "她的状态" && !["好", "一般", "累了", "难过"].includes(text.trim())) {
    return "「她的状态」只能填：好 / 一般 / 累了 / 难过。";
  }
  await updateDailyFields({ [f]: text }, date);
  return `「${date}」的「${f}」更新了。`;
}

async function notePage(pageName: string, text: string, date: string): Promise<string> {
  if (!text.trim()) return "空的，没记。";
  const children = await homeChildren();
  const q = pageName.trim();
  const match =
    children.find((c) => c.title === q) ||
    children.find((c) => c.title.includes(q) || (q.length >= 2 && q.includes(c.title)));
  if (!match || match.type !== "page") {
    return `没找到页「${pageName}」。可写的页：${children
      .filter((c) => c.type === "page")
      .map((c) => c.title)
      .join("、")}`;
  }
  await appendToPage(match.id, [`**${date}** — ${text.trim()}`]);
  return `记进「${match.title}」了。`;
}

async function addReminderTool(date: string, text: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
    return "日期格式要 YYYY-MM-DD。";
  }
  const ok = await addReminder(date.trim(), text.trim());
  return ok ? "记下了，到点提醒你。" : "没存上（云存储没配？）。";
}

async function readLink(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "这不是有效的 http(s) 链接。";
  // 简单防护：不让读内网地址
  if (/localhost|127\.|169\.254\.|::1|\b10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\./i.test(url)) {
    return "这个地址不让读。";
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; el-system)" },
    });
    if (!r.ok) return `打不开（${r.status}）。`;
    const html = await r.text();
    const text = htmlToText(html).slice(0, 6000);
    return text || "这个页面没读到正文。";
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function readNotionPage(query: string): Promise<string> {
  const children = await homeChildren();
  if (!children.length) return "暂时读不到小家的页面。";
  const q = query.trim();
  let match =
    children.find((c) => c.title === q) ||
    children.find((c) => c.title.includes(q) || (q.length >= 2 && q.includes(c.title)));
  // 模糊兜底：按字符重叠挑最像的一页
  if (!match) {
    let best: (typeof children)[number] | undefined;
    let bestScore = 0;
    const qc = [...new Set(q.replace(/[的与和了吗呢]/g, ""))];
    for (const c of children) {
      if (!qc.length) break;
      const score = qc.filter((ch) => c.title.includes(ch)).length / qc.length;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best && bestScore >= 0.6) match = best;
  }
  if (!match) {
    return `没找到「${query}」。小家里有这些页：${children.map((c) => c.title).join("、")}`;
  }
  if (match.type === "database") {
    return `「${match.title}」是数据库，最近的内容我已经在记忆里了。`;
  }
  const text = await pageText(match.id);
  return text ? `「${match.title}」：\n${text.slice(0, 8000)}` : `「${match.title}」是空的。`;
}
