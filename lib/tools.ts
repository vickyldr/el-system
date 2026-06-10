import { homeChildren, pageText } from "./notion";

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
];

export async function runTool(name: string, input: any): Promise<string> {
  try {
    if (name === "read_link") return await readLink(String(input?.url || ""));
    if (name === "read_notion") return await readNotionPage(String(input?.page || ""));
    return "未知工具。";
  } catch (e) {
    return `读取失败：${e instanceof Error ? e.message : "未知错误"}`;
  }
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
