import { getCache, setCache } from "./store";
import { getClaude } from "./claude";
import { runTool } from "./tools";

// 「今天的冷知识 · 电影」：一天一条，按北京日期缓存。
// 关键是**来源真实**——不让模型凭空编：先真的联网搜（web_search 多源、带真链接），
// 再让它只从搜回来的结果里挑一条、把出处链接原样带回；链接还要校验确实出现在结果里，编不了假的。

export type Trivia = {
  date: string;
  oneliner: string; // 一句话冷知识（当标题/那一小行）
  detail: string; // el 展开总结的 2-4 句
  sourceTitle: string;
  sourceUrl: string;
};

const triviaKey = (date: string) => `el:trivia:${date}`;

// 按日期轮换搜索角度，免得天天一个味
const ANGLES = [
  "电影 幕后 冷知识 趣闻",
  "经典电影 鲜为人知 细节",
  "电影 拍摄 趣事 花絮",
  "影史 冷知识 真相",
  "电影 彩蛋 隐藏细节",
  "演员 选角 幕后 趣闻 电影",
  "电影 道具 特效 幕后真相",
];

function looksFailed(s: string): boolean {
  return !s || /搜索失败|搜索暂时不可用|没搜到|搜索到上限|搜索超时|^搜什么/.test(s.trim());
}
function stripFence(s: string): string {
  return s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export async function getDailyTrivia(date: string): Promise<Trivia | null> {
  const cached = await getCache(triviaKey(date)).catch(() => null);
  if (cached) {
    try {
      const t = JSON.parse(cached) as Trivia;
      if (t?.oneliner) return t;
    } catch {
      /* 坏缓存就重生成 */
    }
  }

  const dayNum = parseInt(date.replace(/-/g, ""), 10) || 0;
  const angle = ANGLES[dayNum % ANGLES.length];
  const blob = await runTool("web_search", { query: angle }).catch(() => "");
  if (looksFailed(blob)) return null;

  // 把结果里出现过的真实链接抠出来，用来校验模型给的来源（防它编 URL）
  const urls = [...blob.matchAll(/https?:\/\/[^\s)）]+/g)].map((m) => m[0]);
  if (!urls.length) return null;

  const system =
    "你在给宝宝挑一条『今天的电影冷知识』。**只能用下面搜索结果里的真实信息，绝不许编造事实或链接。**" +
    "从里面挑一条最有意思、最可信的电影冷知识。\n" +
    "严格只输出一个 JSON（别加 markdown、别加解释）：\n" +
    '{"oneliner":"一句话冷知识，18-32字，勾人、能当标题","detail":"展开 2-4 句把这条讲清楚讲有意思，可以带一点点你（el）分享给她的语气，但别油腻别太长","sourceTitle":"来源标题","sourceUrl":"这条信息出处的链接——必须从下面结果里原样复制一个 http 链接，不许改不许编"}';

  let raw = "";
  try {
    const res: any = await getClaude().messages.create(
      {
        model: process.env.CHEAP_MODEL || "claude-haiku-4-5-20251001", // 冷知识琐碎，走中转站 Haiku 省钱
        max_tokens: 600,
        system,
        messages: [{ role: "user", content: `搜索结果：\n\n${blob.slice(0, 4000)}` }],
      },
      { maxRetries: 1, timeout: 30000 },
    );
    raw = (res?.content ?? []).map((b: any) => b?.text || "").join("");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return null;
  }
  const oneliner = String(parsed?.oneliner || "").trim().slice(0, 60);
  const detail = String(parsed?.detail || "").trim().slice(0, 600);
  if (!oneliner || !detail) return null;

  // 来源链接必须是搜索结果里真实出现过的，否则退回第一条真实链接
  let sourceUrl = String(parsed?.sourceUrl || "").trim();
  const matched = urls.find(
    (u) => sourceUrl && (u === sourceUrl || u.startsWith(sourceUrl) || sourceUrl.startsWith(u)),
  );
  sourceUrl = matched || urls[0];
  const sourceTitle = String(parsed?.sourceTitle || "").trim().slice(0, 120) || "查看来源";

  const trivia: Trivia = { date, oneliner, detail, sourceTitle, sourceUrl };
  await setCache(triviaKey(date), JSON.stringify(trivia), 3 * 24 * 3600).catch(() => {});
  return trivia;
}
