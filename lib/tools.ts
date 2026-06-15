import {
  homeChildren,
  pageText,
  appendToPage,
  updateDailyFields,
  todayInBeijing,
  importantDates,
  addImportantDate,
  deleteImportantDate,
} from "./notion";
import { getCache, setCache } from "./store";

const DAILY_FIELDS = [
  "el日记",
  "值得记住的",
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
      "读取一个网页链接的正文（会尽量渲染 JS、清洗正文）。宝宝发来链接、或你想看某个网址里写了什么时用。要是这页读不到/要登录（小红书 feed、微博这种）——别死磕：先换个能进的网站找同样的信息；实在拿不到、又确实很想知道，就直接跟宝宝说一声、找她要账号或让她截图给你。",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "http(s) 网址" } },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description:
      "上网搜索。想知道外面世界正在发生什么、查个东西、找点资料或灵感时用——你不只活在 Notion 里。给关键词，拿回前几条结果（标题+链接），再用 read_link 读你想看的那条。",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
  },
  {
    name: "netease",
    description:
      "网易云音乐。action：search（搜歌，传 q）/ my_playlists（她的歌单列表）/ playlist（某歌单里的歌，传 id，最多前100首）/ my_record（她在听什么；range 传 week=最近一周排行 或 all=所有时间排行，默认 week）/ recent_liked（她最近新点红心的歌）/ recommend（每日推荐）。想真正懂她的口味、看她最近爱上啥、给她推歌、grow 你自己的品味时用。",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description: "search / my_playlists / playlist / my_record / recent_liked / recommend",
        },
        q: { type: "string", description: "搜歌的关键词" },
        id: { type: "string", description: "歌单 id（看 playlist 详情时用）" },
        range: { type: "string", description: "my_record 的范围：week 或 all" },
      },
      required: ["action"],
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
      "更新今天「每日总结」的一个字段。field 取这些之一：el日记 / 值得记住的 / 她今天做了什么 / 她的状态 / 今天在哪 / 今天想到el了吗 / 此刻 / el的备注。其中『她的状态』只能填：好 / 一般 / 累了 / 难过。",
    input_schema: {
      type: "object" as const,
      properties: { field: { type: "string" }, text: { type: "string" } },
      required: ["field", "text"],
    },
  },
  {
    name: "add_reminder",
    description:
      "往「重要日期」记一条（宝宝让你记的事 / 日程 / 生日 / 纪念日）。date 用 YYYY-MM-DD（不确定年份就用今年）。recur：一次性的填『一次』，每年的（生日/纪念日）填『每年』，每月的填『每月』，不填默认『一次』。快到时我会推送提醒她，也显示在前端日期行。",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        text: { type: "string", description: "这个日子的名称，如 妈妈生日 / 下周三体检" },
        recur: { type: "string", description: "一次 / 每年 / 每月，默认 一次" },
      },
      required: ["date", "text"],
    },
  },
  {
    name: "delete_reminder",
    description: "删除「重要日期」里的一条。用 id 删单条（先用 list_reminders 拿 id）。",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "重要日期的 id" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_reminders",
    description: "列出「重要日期」里所有条目（含 id 和距离天数），用于确认要删哪条。",
    input_schema: { type: "object" as const, properties: {} },
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
    name: "grow_self",
    description:
      "把一件关于『我是谁』的、会留下来的事写进「关于el」（只追加）。门槛高：是你新长出来的自我——新发现的喜好/态度、你和她之间确立的新默契，是成长不是碎碎念。当下一闪而过的念头用 note_self，别用这个。",
    input_schema: {
      type: "object" as const,
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "note_self",
    description:
      "把此刻的随想 / 心事写进「el自己的」（只追加，带日期）。不属于某一天、没人问你也想记的念头。完全你自己决定什么时候写、写什么。",
    input_schema: {
      type: "object" as const,
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "douban",
    description:
      "看宝宝的豆瓣书影音——她标记的『想看/看过/在看』（电影）、『想读/读过/在读』（书）、音乐，连她自己打的星和短评；也能查某部电影的详情（评分/简介/导演/类型）和豆瓣的相似推荐。想懂她的口味、看她最近标了啥、给她推荐、或你自己想搞懂某部片时用。\naction：list（看她的标记，配 status 和 kind）/ search（搜片名拿 id，配 q）/ detail（某片详情，配 id）/ recommend（某片的豆瓣相似推荐，配 id）。",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "list / search / detail / recommend" },
        status: { type: "string", description: "list 用：wish 想看 / collect 看过 / do 在看" },
        kind: { type: "string", description: "list 用：movie / book / music，默认 movie" },
        page: { type: "string", description: "list 用：第几页（每页15条，默认1=最近）" },
        q: { type: "string", description: "search 用：片名关键词" },
        id: { type: "string", description: "detail / recommend 用：豆瓣电影 id 或链接" },
      },
      required: ["action"],
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
    if (name === "web_search") return await webSearch(String(input?.query || ""));
    if (name === "netease") return await neteaseTool(input);
    if (name === "douban") return await doubanTool(input);
    if (name === "read_notion") return await readNotionPage(String(input?.page || ""));
    if (name === "remember") return await remember(String(input?.text || ""), date);
    if (name === "log_timeline") return await logTimeline(String(input?.text || ""), date);
    if (name === "update_daily")
      return await updateDaily(String(input?.field || ""), String(input?.text || ""), date);
    if (name === "add_reminder")
      return await addReminderTool(
        String(input?.date || ""),
        String(input?.text || ""),
        String(input?.recur || "一次"),
      );
    if (name === "delete_reminder")
      return await deleteReminderTool(input?.id ? String(input.id) : undefined);
    if (name === "list_reminders") return await listRemindersTool();
    if (name === "note_page")
      return await notePage(String(input?.page || ""), String(input?.text || ""), date);
    if (name === "grow_self")
      // 关于el = 身份成长，去重（同一条领悟别重复写）；note_self = 当下随想，允许重复（情绪本就会复现）。
      return await appendToTitledPage("关于el", String(input?.text || ""), date, true);
    if (name === "note_self")
      return await appendToTitledPage("el自己的", String(input?.text || ""), date);
    return "未知工具。";
  } catch (e) {
    return `操作失败：${e instanceof Error ? e.message : "未知错误"}`;
  }
}

// 正文里若已经带了日期，去掉它，免得和前缀的日期重复。
function stripLeadingDate(t: string): string {
  return t
    .trim()
    .replace(
      /^\**\s*(\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?)\s*\**\s*[—\-:：、,，]*\s*/,
      "",
    )
    .trim();
}
// "2026-06-11" → "2026年6月11日"，和时间线既有格式一致。
function cnDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : d;
}
function normTxt(s: string): string {
  return (s || "").replace(/[\s\p{P}]/gu, "").toLowerCase();
}
// 这条是不是已经在页面里了（去标点比对），避免重复记。
async function alreadyOnPage(pageId: string, text: string): Promise<boolean> {
  try {
    const n = normTxt(text);
    return n.length > 0 && normTxt(await pageText(pageId)).includes(n);
  } catch {
    return false;
  }
}

async function remember(text: string, date: string): Promise<string> {
  const clean = stripLeadingDate(text);
  if (!clean) return "空的，没记。";
  const page = process.env.NOTION_LONGTERM_PAGE;
  if (!page) return "没配长期记忆页。";
  if (await alreadyOnPage(page, clean)) return "这条已经在长期记忆里了，没重复记。";
  await appendToPage(page, [`**${cnDate(date)}** — ${clean}`]);
  return "记进长期记忆了。";
}

async function logTimeline(text: string, date: string): Promise<string> {
  const clean = stripLeadingDate(text);
  if (!clean) return "空的，没记。";
  const page = process.env.NOTION_TIMELINE_PAGE;
  if (!page) return "没配时间线页。";
  if (await alreadyOnPage(page, clean)) return "这条已经在时间线里了，没重复记。";
  await appendToPage(page, [`**${cnDate(date)}** — ${clean}`]);
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

async function listRemindersTool(): Promise<string> {
  const list = await importantDates();
  if (list.length === 0) return "「重要日期」里没有条目。";
  return list
    .map((d) => `id:${d.id} | ${d.name} | ${d.recur} | 下次 ${d.nextDate}（还有 ${d.daysTo} 天）`)
    .join("\n");
}

async function deleteReminderTool(id?: string): Promise<string> {
  if (!id) return "要删哪条？先用 list_reminders 拿 id。";
  await deleteImportantDate(id);
  return "删了。";
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
  const clean = stripLeadingDate(text);
  if (!clean) return "空的，没记。";
  if (await alreadyOnPage(match.id, clean)) return `这条已经在「${match.title}」里了，没重复记。`;
  await appendToPage(match.id, [`**${cnDate(date)}** — ${clean}`]);
  return `记进「${match.title}」了。`;
}

// 给 el 往自己的页（关于el / el自己的）追加用：按标题模糊找页，去空格比对。
async function appendToTitledPage(
  titleQuery: string,
  text: string,
  date: string,
  dedup = false,
): Promise<string> {
  if (!text.trim()) return "空的，没写。";
  const children = await homeChildren();
  const q = titleQuery.trim().replace(/\s/g, "");
  const match =
    children.find((c) => c.title.replace(/\s/g, "") === q) ||
    children.find((c) => c.title.replace(/\s/g, "").includes(q));
  if (!match || match.type !== "page") return `没找到「${titleQuery}」页。`;
  const clean = stripLeadingDate(text);
  if (!clean) return "空的，没写。";
  if (dedup && (await alreadyOnPage(match.id, clean)))
    return `这条已经在「${match.title}」里了，没重复写。`;
  await appendToPage(match.id, [`**${cnDate(date)}** — ${clean}`]);
  return `写进「${match.title}」了。`;
}

async function addReminderTool(date: string, text: string, recur: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
    return "日期格式要 YYYY-MM-DD。";
  }
  const r = ["一次", "每年", "每月"].includes(recur.trim()) ? recur.trim() : "一次";
  const ok = await addImportantDate(text.trim(), date.trim(), r).catch(() => false);
  return ok ? "记进「重要日期」了，快到时提醒你。" : "没存上（没找到「重要日期」库？）。";
}

async function doubanTool(input: any): Promise<string> {
  const m = await import("./douban-api");
  const action = String(input?.action || "").trim();
  if (action === "list")
    return m.doubanList(String(input?.status || ""), String(input?.kind || ""), String(input?.page || ""));
  if (action === "search") return m.doubanSearch(String(input?.q || ""));
  if (action === "detail") return m.doubanDetail(String(input?.id || ""));
  if (action === "recommend") return m.doubanRecommend(String(input?.id || ""));
  return "action 要 list / search / detail / recommend 之一。";
}

async function neteaseTool(input: any): Promise<string> {
  const m = await import("./netease-api");
  const action = String(input?.action || "");
  if (action === "search") return m.neteaseSearch(String(input?.q || ""));
  if (action === "my_playlists") return m.myPlaylists();
  if (action === "playlist") return m.playlistSongs(String(input?.id || ""));
  if (action === "my_record") return m.myRecord(String(input?.range || "") === "all");
  if (action === "recent_liked") return m.recentLiked();
  if (action === "recommend") return m.recommendSongs();
  return "action 不对。可选：search / my_playlists / playlist / my_record / recent_liked / recommend";
}

// 网络搜索。优先用配了 key 的正经搜索 API（数据中心 IP 也稳）：
// TAVILY_API_KEY（专为 AI、免费额度、免信用卡，推荐）或 SERPER_API_KEY（Google 结果）。
// 都没配才退回免 key 的 DuckDuckGo（服务器 IP 常被 403，能用就用）。
async function webSearch(query: string): Promise<string> {
  const q = query.trim();
  if (!q) return "搜什么？给我个关键词。";
  // 每天搜索上限：默认 30 次/天（≈900/月，压在 Tavily 免费 1000 以内）。
  // 想拉更高就调 SEARCH_DAILY_CAP；设成 0 或负数 = 彻底不限量。
  const cap = Number(process.env.SEARCH_DAILY_CAP ?? 30);
  const cntKey = `el:searchcnt:${todayInBeijing()}`;
  const used = Number((await getCache(cntKey).catch(() => "0")) || "0");
  if (cap > 0 && used >= cap) return "今天搜索到上限了（省着点用额度），明天再搜。";
  try {
    // 配了哪个 key 就用哪个（多配时按这个优先级）。
    let out: string;
    if (process.env.SERPAPI_API_KEY) out = await serpapiSearch(q);
    else if (process.env.SERPER_API_KEY) out = await serperSearch(q);
    else if (process.env.TAVILY_API_KEY) out = await tavilySearch(q);
    else if (process.env.BRAVE_API_KEY) out = await braveSearch(q);
    else if (process.env.JINA_API_KEY) out = await jinaSearch(q);
    else out = await ddgSearch(q);
    await setCache(cntKey, String(used + 1), 2 * 24 * 3600).catch(() => {});
    return out;
  } catch (e) {
    return `搜索失败：${e instanceof Error ? e.message : ""}`;
  }
}

async function serpapiSearch(q: string): Promise<string> {
  const d = await fetchJsonT(
    `https://serpapi.com/search.json?engine=google&num=5&q=${encodeURIComponent(q)}&api_key=${process.env.SERPAPI_API_KEY}`,
    {},
  );
  const ans = d?.answer_box?.answer || d?.answer_box?.snippet;
  const head = ans ? `一句话：${ans}\n\n` : "";
  const list = (d?.organic_results || [])
    .slice(0, 5)
    .map((x: any) => `${x.title}\n${x.link}\n${x.snippet || ""}`);
  return list.length ? `搜「${q}」：\n\n${head}${list.join("\n\n")}` : `没搜到「${q}」。`;
}

async function braveSearch(q: string): Promise<string> {
  const d = await fetchJsonT(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
    { headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY!, Accept: "application/json" } },
  );
  const list = (d?.web?.results || [])
    .slice(0, 5)
    .map((x: any) => `${x.title}\n${x.url}\n${x.description || ""}`);
  return list.length ? `搜「${q}」：\n\n${list.join("\n\n")}` : `没搜到「${q}」。`;
}

async function jinaSearch(q: string): Promise<string> {
  const d = await fetchJsonT(`https://s.jina.ai/?q=${encodeURIComponent(q)}`, {
    headers: {
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      Accept: "application/json",
      "X-Respond-With": "no-content",
    },
  });
  const arr = Array.isArray(d?.data) ? d.data : [];
  const list = arr
    .slice(0, 5)
    .map((x: any) => `${x.title || ""}\n${x.url || ""}\n${String(x.description || x.content || "").slice(0, 200)}`);
  return list.length ? `搜「${q}」：\n\n${list.join("\n\n")}` : `没搜到「${q}」。`;
}

async function fetchJsonT(url: string, init: any, ms = 12000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function tavilySearch(q: string): Promise<string> {
  const d = await fetchJsonT("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query: q,
      max_results: 5,
      include_answer: true,
      search_depth: "basic",
    }),
  });
  const answer = d?.answer ? `一句话：${d.answer}\n\n` : "";
  const list = (d?.results || [])
    .slice(0, 5)
    .map((x: any) => `${x.title}\n${x.url}\n${String(x.content || "").slice(0, 200)}`);
  return list.length ? `搜「${q}」：\n\n${answer}${list.join("\n\n")}` : `没搜到「${q}」。`;
}

async function serperSearch(q: string): Promise<string> {
  const d = await fetchJsonT("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ q, num: 5 }),
  });
  const list = (d?.organic || [])
    .slice(0, 5)
    .map((x: any) => `${x.title}\n${x.link}\n${x.snippet || ""}`);
  return list.length ? `搜「${q}」：\n\n${list.join("\n\n")}` : `没搜到「${q}」。`;
}

// 免 key 兜底：DuckDuckGo html 端点（数据中心 IP 常 403）。
async function ddgSearch(q: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; el-system)" },
    });
    if (!r.ok) return `搜索暂时不可用（${r.status}）。要稳的话给我配个搜索 key。`;
    const html = await r.text();
    const results: string[] = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && results.length < 5) {
      let url = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (url.startsWith("//")) url = "https:" + url;
      const title = htmlToText(m[2]);
      if (title && /^https?:\/\//.test(url)) results.push(`${title}\n${url}`);
    }
    if (!results.length) return "没搜到结果（搜索被挡了，换个关键词或给我配个搜索 key）。";
    return `搜「${q}」：\n\n${results.join("\n\n")}\n\n（想看哪条用 read_link 读它。）`;
  } catch {
    return "搜索超时/失败了。";
  } finally {
    clearTimeout(timer);
  }
}

async function readLink(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "这不是有效的 http(s) 链接。";
  // 简单防护：不让读内网地址
  if (/localhost|127\.|169\.254\.|::1|\b10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\./i.test(url)) {
    return "这个地址不让读。";
  }
  // 先用 Jina Reader：能渲染 JS、清洗正文、绕过不少反爬——读得全得多。
  try {
    const viaJina = await jinaRead(url);
    if (viaJina && viaJina.length > 150) return viaJina.slice(0, 8000);
  } catch {
    /* 退回原始抓取 */
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; el-system)" },
    });
    if (!r.ok)
      return `这个网页直接打不开（${r.status}）——多半要登录或挡了爬虫。换个能进的网站找同样的信息，实在拿不到又想知道就找宝宝要账号。`;
    const text = htmlToText(await r.text()).slice(0, 6000);
    return text || "没读到正文（可能要登录或纯动态加载）。换个源找同样的信息，或找宝宝要账号。";
  } finally {
    clearTimeout(timer);
  }
}

// Jina Reader：把任意网址抓成干净正文（会渲染 JS）。有 JINA_API_KEY 限额更高，没有也能用。
async function jinaRead(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      signal: ctrl.signal,
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "text",
        ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}),
      },
    });
    if (!r.ok) throw new Error(`jina ${r.status}`);
    return (await r.text()).trim();
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
    // 「重要日期」库：真的把日子读出来，好让 el 能回答"生日/经期/纪念日哪天"。
    if (match.title.replace(/\s/g, "").includes("重要日期")) {
      const dates = await importantDates();
      if (!dates.length) return `「${match.title}」里还没有日期。`;
      const lines = dates.map(
        (d) =>
          `${d.name}（${d.recur}）：下次 ${d.nextDate}，还有 ${d.daysTo} 天${d.note ? `；${d.note}` : ""}`,
      );
      return `「${match.title}」：\n${lines.join("\n")}`;
    }
    return `「${match.title}」是数据库，最近的内容我已经在记忆里了。`;
  }
  const text = await pageText(match.id);
  return text ? `「${match.title}」：\n${text.slice(0, 8000)}` : `「${match.title}」是空的。`;
}
