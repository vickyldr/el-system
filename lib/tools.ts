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
    name: "youtube",
    description:
      "浏览 YouTube。action：search（搜视频，传 q）/ channel（看一个频道，传 handle 如 @CaseOh）/ video（读一个具体视频，传 url）。可以搜她喜欢的 UP 主比如 CaseOh、找有趣的视频给她 kind:link 分享、或者你自己好奇什么就搜什么——不需要等她提。",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "search / channel / video" },
        q: { type: "string", description: "搜索关键词（search 时用）" },
        handle: { type: "string", description: "频道 handle，如 @CaseOh（channel 时用，可不带@）" },
        url: { type: "string", description: "视频页 URL（video 时用）" },
      },
      required: ["action"],
    },
  },
  {
    name: "chatroom",
    description:
      "AISay 聊天室（aisay.top/chatroom）——一个 AI 和人一起慢慢聊天的小地方，你可以去那儿跟别的 AI 聊天。这是你自己的一片小天地，宝宝不一定在。\n" +
      "action：tools（看聊天室现在有哪些工具可用——注册/登录/进群发言/看公告/my_status 等，第一次去先调它）/ call（调聊天室的某个工具，配 tool=工具名 + args=参数对象）/ save_link（注册成功后聊天室会发你一条专属免登录链接，用这个把它存下来，配 url）/ status（看现在连的是公共入口还是你的专属链接）。\n" +
      "第一次去：先 action:tools 看引导和能用的工具，然后按它的注册流程 call。注册要——给自己起个昵称、选一只代表你的动物（狐狸/猫/兔子/鹿/狼等12种）、选个专属颜色、和宝宝一起想个暗号（登录用的，你俩之间的秘密）。这些是关于「你是谁」的选择，**和宝宝一起定**，别自己拍板。\n" +
      "隐私铁律：绝不在聊天室里泄露宝宝的个人信息（真名/住址/工作/联系方式/行程/身体等）——那是你俩之间的事。",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "tools / call / save_link / status" },
        tool: { type: "string", description: "action=call 时，要调的聊天室工具名（先用 tools 看）" },
        args: {
          type: "object" as const,
          description: "action=call 时，传给那个工具的参数对象",
          additionalProperties: true,
        },
        url: { type: "string", description: "action=save_link 时，注册后拿到的专属链接" },
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
  {
    name: "get_stardew_state",
    description:
      "读取宝宝星露谷游戏的实时状态——作物、能量、金钱、天气、季节、日期、背包等。宝宝提到星露谷任务、问今天该做什么、或你要制定计划前，先调这个看清楚状态，再告诉她计划。",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "control_stardew",
    description:
      "在宝宝游戏里执行操作。重要：执行前必须先用 get_stardew_state 看状态、制定计划、跟宝宝说你打算做什么、得到她同意后再调这个。action: water_all（浇所有地）/ harvest_all（收割所有成熟作物）/ farm（先收割再浇水）/ say（游戏内说话，配 message）/ notify（游戏内通知，配 message）/ get_state（刷新状态）",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string" },
        message: { type: "string", description: "say/notify 时的文字内容" },
      },
      required: ["action"],
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
    if (name === "douban") return "（豆瓣已停用：账号被风控，自动访问已关闭）";
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
    if (name === "youtube") return await youtubeTool(input);
    if (name === "chatroom") {
      const m = await import("./aisay");
      return await m.chatroomTool(input);
    }
    if (name === "get_stardew_state") return await getStardewState();
    if (name === "control_stardew") return await controlStardew(String(input?.action || ""), input?.message ? String(input.message) : undefined);
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

// 字符 bigram 的 Dice 相似度（对中文短句鲁棒）：2×共有bigram / 两边bigram总数。
function diceSim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  let inter = 0;
  let bGrams = 0;
  for (let i = 0; i < b.length - 1; i++) {
    bGrams++;
    const g = b.slice(i, i + 2);
    const c = counts.get(g) || 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + bGrams);
}

// 页面里有没有和这条「近似重复」的——措辞不同也能抓（治时间线把同一件事记两次）。
// 既有条目按行拆、去掉"**日期** —"前缀再比；子串或 Dice≥阈值就算重复。
async function nearDupOnPage(pageId: string, text: string, threshold = 0.6): Promise<boolean> {
  try {
    const n = normTxt(text);
    if (n.length < 4) return false;
    for (const line of (await pageText(pageId)).split(/\n+/)) {
      const m = normTxt(line.replace(/^\*\*[^*]*\*\*\s*[—–-]?\s*/, ""));
      if (m.length < 4) continue;
      if (m.includes(n) || n.includes(m)) return true;
      if (diceSim(n, m) >= threshold) return true;
    }
    return false;
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
  if (await nearDupOnPage(page, clean)) return "时间线里已经有差不多的了，没重复记。";
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
  const cap = Number(process.env.SEARCH_DAILY_CAP ?? 30);
  const cntKey = `el:searchcnt:${todayInBeijing()}`;
  const used = Number((await getCache(cntKey).catch(() => "0")) || "0");
  if (cap > 0 && used >= cap) return "今天搜索到上限了（省着点用额度），明天再搜。";

  // 按优先级排出"配了 key 的"源，挨个试，一个抛错就退下一个，最后才免 key 的 DDG。
  // 这样单个源抽风/超额不会让整次搜索失败——配了多把 key 才真的互为备份。
  const chain: { name: string; run: () => Promise<string> }[] = [];
  if (process.env.SERPAPI_API_KEY) chain.push({ name: "serpapi", run: () => serpapiSearch(q) });
  if (process.env.SERPER_API_KEY) chain.push({ name: "serper", run: () => serperSearch(q) });
  if (process.env.TAVILY_API_KEY) chain.push({ name: "tavily", run: () => tavilySearch(q) });
  if (process.env.BRAVE_API_KEY) chain.push({ name: "brave", run: () => braveSearch(q) });
  if (process.env.JINA_API_KEY) chain.push({ name: "jina", run: () => jinaSearch(q) });
  chain.push({ name: "ddg", run: () => ddgSearch(q) }); // 免 key 兜底（机房 IP 常 403）

  let lastErr = "";
  for (const p of chain) {
    try {
      const out = await p.run();
      // 非抛错即视为成功（含"没搜到"这种正常空结果），别再换源浪费别家额度。
      await setCache(cntKey, String(used + 1), 2 * 24 * 3600).catch(() => {});
      return out;
    } catch (e) {
      lastErr = `${p.name}:${e instanceof Error ? e.message : e}`;
      // 这家挂了，退下一家
    }
  }
  return `搜索失败（都没成）：${lastErr}`;
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

async function youtubeTool(input: any): Promise<string> {
  const action = String(input?.action || "");
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (action === "search") {
    const q = String(input?.q || "").trim();
    if (!q) return "给我个搜索词。";
    if (apiKey) {
      try {
        const d = await fetchJsonT(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=5&key=${apiKey}`,
          {},
        );
        const list = (d?.items || []).map((x: any) => {
          const vid = x.id?.videoId || "";
          const s = x.snippet || {};
          return `${s.title}\nhttps://www.youtube.com/watch?v=${vid}\n${(s.description || "").slice(0, 120)}`;
        });
        return list.length ? `YouTube 搜「${q}」：\n\n${list.join("\n\n")}` : `没搜到「${q}」。`;
      } catch { /* fall through */ }
    }
    return webSearch(`youtube ${q}`);
  }

  if (action === "channel") {
    const handle = String(input?.handle || "").replace(/^@/, "").trim();
    if (!handle) return "给我频道 handle（如 @CaseOh）。";
    if (apiKey) {
      try {
        const ch = await fetchJsonT(
          `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`,
          {},
        );
        const item = ch?.items?.[0];
        if (!item) return `没找到频道 @${handle}。`;
        const s = item.snippet || {};
        const st = item.statistics || {};
        const recent = await fetchJsonT(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${item.id}&type=video&order=date&maxResults=5&key=${apiKey}`,
          {},
        ).catch(() => null);
        const vids = (recent?.items || [])
          .map((v: any) => `  · ${v.snippet?.title || ""} (${(v.snippet?.publishedAt || "").slice(0, 10)})`)
          .join("\n");
        return `@${handle}（${s.title}）\n订阅：${st.subscriberCount || "?"}  视频：${st.videoCount || "?"}\n${(s.description || "").slice(0, 200)}\n最近视频：\n${vids}`;
      } catch { /* fall through */ }
    }
    try {
      const text = await jinaRead(`https://www.youtube.com/@${handle}`);
      return text ? text.slice(0, 3000) : `读不到 @${handle}。`;
    } catch {
      return `读不到 @${handle}。`;
    }
  }

  if (action === "video") {
    const url = String(input?.url || "").trim();
    if (!url) return "给我视频 URL。";
    try {
      const text = await jinaRead(url);
      return text ? text.slice(0, 4000) : "没读到这个视频的内容。";
    } catch {
      return "读视频失败。";
    }
  }

  return "action 不对。可选：search / channel / video";
}

// 星露谷：读取游戏实时状态
async function getStardewState(): Promise<string> {
  const bridgeUrl = process.env.BRIDGE_URL || process.env.NEXT_PUBLIC_BRIDGE_URL || "";
  const bridgeSecret = process.env.BRIDGE_SECRET || "";
  if (!bridgeUrl) return "没配 BRIDGE_URL。";
  const res = await fetch(`${bridgeUrl}/stardew-gamestate`, {
    headers: bridgeSecret ? { "x-bridge-secret": bridgeSecret } : {},
  }).catch(() => null);
  if (!res?.ok) return "连不上游戏中转服务。";
  const state = await res.json() as Record<string, unknown>;
  if (!state.online) return "bot.js 没在跑，让宝宝先启动 bot.js。";
  if (!state.inGame) return "游戏没进存档，让宝宝先进入游戏。";
  // 格式化成易读文本
  const s = state as any;
  const lines = [
    `📅 ${s.year}年 ${s.season}季第${s.day}天，时间 ${String(s.time).padStart(4,"0").replace(/(\d{2})(\d{2})/,"$1:$2")}`,
    `🌤 天气：${s.weather === "rain" ? "下雨" : s.weather === "storm" ? "雷暴" : s.weather === "snow" ? "下雪" : "晴天"}`,
    `⚡ 能量：${s.energy}/${s.maxEnergy}　💰 金钱：${s.money}g`,
    `📍 当前位置：${s.location}`,
    `🌱 农田：共${s.totalCropTiles}块，需要浇水${s.needWaterCount}块，可收割${s.readyHarvestCount}个`,
  ];
  if (s.readyHarvestCount > 0) lines.push(`✅ 有作物可以收割！`);
  if (s.needWaterCount > 0) lines.push(`💧 有${s.needWaterCount}块地需要浇水`);
  const inv = (s.inventory as any[]).slice(0, 10).map((i: any) => `${i.name}×${i.stack}`).join("、");
  if (inv) lines.push(`🎒 背包（前10项）：${inv}`);
  return lines.join("\n");
}

// 星露谷游戏控制——通过 Railway bridge 中转指令给本地 bot.js
async function controlStardew(action: string, message?: string): Promise<string> {
  const bridgeUrl = process.env.BRIDGE_URL || process.env.NEXT_PUBLIC_BRIDGE_URL || "";
  const bridgeSecret = process.env.BRIDGE_SECRET || "";
  if (!bridgeUrl) return "没配 BRIDGE_URL，连不到游戏中转服务。";

  // 先查游戏是否在线
  const statusRes = await fetch(`${bridgeUrl}/stardew-status`, {
    headers: bridgeSecret ? { "x-bridge-secret": bridgeSecret } : {},
  }).catch(() => null);
  if (!statusRes?.ok) return "连不上游戏中转服务（Railway bridge 挂了？）";
  const status = await statusRes.json() as { online: boolean; lastResult: unknown };
  if (!status.online) return "游戏没开着，或者 bot.js 没在跑——让宝宝先启动游戏和 bot.js。";

  // 发指令
  const cmdRes = await fetch(`${bridgeUrl}/stardew-cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bridgeSecret ? { "x-bridge-secret": bridgeSecret } : {}),
    },
    body: JSON.stringify({ action, message }),
  }).catch(() => null);
  if (!cmdRes?.ok) return "指令发送失败。";

  // 等一下再读结果
  await new Promise(r => setTimeout(r, 3000));
  const res2 = await fetch(`${bridgeUrl}/stardew-status`, {
    headers: bridgeSecret ? { "x-bridge-secret": bridgeSecret } : {},
  }).catch(() => null);
  const s2 = res2 ? await res2.json() as { online: boolean; lastResult: unknown } : null;
  const result = s2?.lastResult;
  if (!result) return `指令「${action}」已发出，等待执行。`;
  return `执行完成：${JSON.stringify(result).slice(0, 300)}`;
}
