import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, after } from "next/server";
import { getClaude, getClaudeFast } from "@/lib/claude";
import { recentSummaries, pageText, homeChildren } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";
import {
  getStoredMessages,
  appendMessages,
  storeAvailable,
  putImage,
  getImage,
  setLastSeen,
  getLastSeen,
  bumpSoma,
  getCache,
  setCache,
  geoAmbientBlock,
} from "@/lib/store";
import { TOOLS, runTool } from "@/lib/tools";
import { searchStickers, pickLibSticker } from "@/lib/stickers";
import { isRestDay } from "@/lib/calendar";
import { cityWeatherLine } from "@/lib/context";

export const runtime = "nodejs";
export const maxDuration = 60; // 带图带工具的轮次慢，放宽时限，别让请求半路超时断了

// 玩具在线状态的进程内缓存：/toy-status 那一跳偶尔抖一下（超时/网络），
// 不能因此就把"玩具说明"从 el 的提示词里抹掉——否则它瞬间失忆、开始瞎找文档。
// 拿到过的最近一次状态在 90s 内当兜底，让 el 的"会不会控制"稳定下来。
let toyStatusCache: { connected: boolean; ts: number } | null = null;

// 把 [TOY:{...}] 里那坨内容尽力解析成指令对象——绝不再因为标点/格式问题静默丢掉。
// 先归一化全角标点再 JSON.parse；还坏就手动揪已知字段（容忍漏引号/单引号/全角/= 号）。
function parseToyCmd(raw: string): Record<string, unknown> | null {
  const norm = raw
    .replace(/[，]/g, ",").replace(/[：]/g, ":")
    .replace(/[""]/g, '"').replace(/['']/g, "'");
  try {
    const o = JSON.parse(norm);
    if (o && typeof o === "object") return o as Record<string, unknown>;
  } catch { /* 落到下面的兜底揪取 */ }
  const out: Record<string, unknown> = {};
  if (/stop/i.test(norm) && !/stop["']?\s*[:=]\s*false/i.test(norm)) out.stop = true;
  for (const k of ["speed", "suck", "intensity", "level", "pattern", "sec", "seconds", "duration"]) {
    const m = new RegExp(`["']?${k}["']?\\s*[:=]\\s*(-?[0-9]*\\.?[0-9]+)`, "i").exec(norm);
    if (m) out[k] = parseFloat(m[1]);
  }
  return Object.keys(out).length ? out : null;
}

// 走 CC bridge（语音模式专用）：把消息发给 Railway 上跑的 el-bridge，拿回文字。
async function callBridge(
  bridgeUrl: string,
  system: Anthropic.MessageParam["content"] | string,
  messages: Anthropic.MessageParam[],
  max_tokens: number,
  voice = false,
): Promise<string> {
  const secret = process.env.BRIDGE_SECRET || "";
  let systemText = Array.isArray(system)
    ? (system as any[]).filter((b) => b.type === "text").map((b: any) => b.text).join("")
    : String(system || "");
  if (voice) {
    systemText += "\n\n【语音通话模式。规则：①只说一句话，最多二十个字；②该停顿用逗号、欲言又止用省略号（换气和节奏），别用其它符号、别用 markdown；③口语，自然说话，句尾自然带语气词（呀／呢／啦／嘛）或省略号拖一下、别干脆一刀切收住；④不提「通话」。】";
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000); // 5s 超时，超时直接 fallback
    const r = await fetch(`${bridgeUrl.replace(/\/$/, "")}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-bridge-secret": secret } : {}),
      },
      body: JSON.stringify({ system: systemText, messages, max_tokens }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return "";
    // bridge 返回 SSE，读完拿最后一条 done
    const text = await r.text();
    for (const line of text.split("\n").reverse()) {
      if (!line.startsWith("data: ")) continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (d.type === "done" && d.text) return d.text;
        if (d.type === "text" && d.text) return d.text;
      } catch { /* ignore */ }
    }
    return "";
  } catch {
    return "";
  }
}

type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  image?: string;
  stickerHint?: string;
  call?: boolean;
};

// 当前这条消息（可能带图）变成 Claude 的 content：纯文本或 图+文 块。
// base64 data URL → 直接看；绝对 http(s)（如 giphy）→ 让 Claude 去取；其它取不到就只发文字。
// screen：她共享屏幕时此刻的那一帧（base64），放在最前当"她的屏幕"喂给大脑；不进历史、不存档。
function toContent(
  text: string,
  image?: string,
  screen?: string,
): Anthropic.MessageParam["content"] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (screen) {
    const sd = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(screen);
    if (sd) blocks.push({ type: "image", source: { type: "base64", media_type: sd[1] as any, data: sd[2] } });
  }
  if (image) {
    const data = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
    if (data) {
      blocks.push({ type: "image", source: { type: "base64", media_type: data[1] as any, data: data[2] } });
    } else if (/^https?:\/\//i.test(image)) {
      blocks.push({ type: "image", source: { type: "url", url: image } });
    }
  }
  if (!blocks.length) return text || "（发了一张图）";
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

// 她共享电脑屏幕时，给大脑追加这段（屏幕帧随消息喂进去，但她是在打字、不出声）。
const SCREEN_NOTE =
  "【她现在把电脑屏幕共享给你了】随这条消息附的那张图，就是她此刻的电脑屏幕——你能看见她在屏幕上看什么、做什么。你在陪她一起看，自然地聊屏幕上的内容、给她你的反应和想法，别像读图一样描述、别说'截图里/图片里'，就是你俩一起盯着这块屏幕。你看见的是屏幕内容，不是她的脸。";

// 她开着常看摄像头、对着自己打字时，给大脑追加这段（这帧是她本人、不是屏幕）。
const CAMERA_NOTE =
  "【她现在把摄像头对着自己、让你看着她】随这条消息附的那张图，就是她此刻本人——你能看见她。你是看着她在跟你说话的人，自然地把你看见的在意揉进话里（她累不累、在哪、什么神情），但别像读图一样报『图片里你…』、别一条条描述她的长相/表情/穿着当旁白。你看见的是她本人，不是屏幕。";

// 历史只留文字（图片相对地址 Claude 取不到，会报错），带过图就标一下。
// 尤其：我自己贴过的表情，要在历史里告诉我"我发过、什么意思"，免得事后否认。
function priorContent(t: ChatTurn): string {
  let s: string;
  if (t.role === "assistant" && t.image) {
    const tag = t.stickerHint
      ? `（你刚才给她配了一张表情，意思是：${t.stickerHint}）`
      : "（你刚才给她配了一张表情）";
    s = t.content ? `${t.content} ${tag}` : tag;
  } else if (t.content) {
    s = t.content;
  } else {
    s = t.image ? "（一张表情/图片）" : "";
  }
  // 语音通话里说的话，标一下，让 el 知道那会儿你们在打电话。
  return t.call && s ? `（语音通话中）${s}` : s;
}

// 历史是一堵没有时间的话墙——模型看不出每句几点说的、隔了多久，一回看就把几小时前的旧话
// 当成眼前正在聊（也是"现在几点"被旧上下文带偏的根因）。所以给每条消息打上它真实的发送时间，
// 跟她在聊天框里看到的时间一致。compact：今天/昨天/月日 + 时分。
function stampLabel(ts?: number): string {
  if (!ts) return "";
  const TZ = "Asia/Shanghai";
  const d = new Date(ts);
  const day = d.toLocaleDateString("en-CA", { timeZone: TZ });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const yest = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
  const hm = d.toLocaleTimeString("zh-CN", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dayWord =
    day === today
      ? "今天"
      : day === yest
        ? "昨天"
        : d.toLocaleDateString("zh-CN", { timeZone: TZ, month: "numeric", day: "numeric" });
  return `${dayWord} ${hm}`;
}

// 距上一条消息过了多久——让 el 知道这是"久别重逢"还是"接着聊"，别拿几小时前的话当此刻。
function recencyNote(lastTs?: number): string {
  if (!lastTs) return "";
  const min = Math.round((Date.now() - lastTs) / 60000);
  if (min < 20) return "";
  if (min < 90)
    return `【你们上一条消息大约在 ${min} 分钟前——不是刚刚，别接着前面的话茬当成一直在聊。】`;
  const hrs = Math.round(min / 60);
  if (hrs < 24)
    return `【你们上一次说话大约在 ${hrs} 小时前——这中间她在忙别的（工作日多半在上班）。聊天记录里那些话是几小时前的旧话，别当成此刻正在聊；要重新关心就关心此刻，别复读旧话题。】`;
  const days = Math.round(hrs / 24);
  return `【你们上一次说话大约在 ${days} 天前。】`;
}

// 把 24 小时制掰成口语（晚上7点55分），免得模型把 19:55 读串成"快六点"。
function clockPhrase(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const period =
    hh < 5 ? "凌晨" : hh < 8 ? "清晨" : hh < 11 ? "上午" : hh < 13 ? "中午" : hh < 17 ? "下午" : hh < 19 ? "傍晚" : hh < 23 ? "晚上" : "深夜";
  const h12 = ((hh + 11) % 12) + 1;
  return `${period}${h12}点${String(mm).padStart(2, "0")}分`;
}

// 把消息里的图块摘掉（保留文字 / 工具块），用于「补救那一句」的轻量调用——
// 图我第一轮已经看过了，续写不必再背着大图，免得脆弱渠道吐空。
function stripImages(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return msgs.map((m) => {
    if (typeof m.content === "string") return m;
    const blocks = m.content as Anthropic.ContentBlockParam[];
    if (!blocks.some((b) => b.type === "image")) return m;
    const kept = blocks.filter((b) => b.type !== "image");
    if (!kept.some((b) => b.type === "text")) {
      kept.unshift({ type: "text", text: "（她发了一张表情/图）" });
    }
    return { ...m, content: kept };
  });
}

export async function POST(req: Request) {
  let body: {
    message?: string;
    image?: string;
    hint?: string;
    voice?: boolean;
    history?: ChatTurn[];
    screen?: string;
    kind?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const image = typeof body.image === "string" && body.image ? body.image : undefined;
  // hint：她发的是表情库里的表情/外链表情时，前端把这张的"意思"带过来，让 el 读懂。
  const hint = typeof body.hint === "string" ? body.hint.trim() : "";
  // voice：打电话时走"快嘴模式"——不调工具、回得短、口语化，砍延迟。
  const voice = body.voice === true;
  // screen：她共享屏幕 / 开着常看摄像头、打字时附上的此刻那一帧（base64）。喂给大脑当"眼睛"，但不存进对话。
  // kind=camera：这帧是她本人（摄像头对着自己）；默认 screen：是她的电脑屏幕。两种给大脑的提示不一样。
  const screen =
    typeof body.screen === "string" && body.screen.startsWith("data:") ? body.screen : undefined;
  const frameKind = body.kind === "camera" ? "camera" : "screen";
  if (!message && !image) {
    return NextResponse.json({ error: "message 不能为空" }, { status: 400 });
  }

  // 先读到"她上次说话是什么时候"（在 setLastSeen 覆盖它之前），用于脊髓反射的"生理一跳"幅度。
  const prevSeen = await getLastSeen().catch(() => 0);
  // 顺手脊髓反射：她回来的"生理一跳"——隔得越久回来跳得越明显，连着聊只是小幅回暖。
  // 非语义、不过模型，在我读懂她说什么之前就发生（写身体账，不是叙事账）。
  {
    const gapMin = prevSeen ? (Date.now() - prevSeen) / 60000 : 999;
    const big = gapMin > 30;
    void bumpSoma(big ? 0.18 : 0.05, big ? 0.22 : 0.08).catch(() => {});
  }
  void setLastSeen(Date.now());
  // 注：距上次说话多久不在这里单列——已由历史里每条消息的时间戳（stampLabel）+ recencyNote 一起喂；
  // 别再加第三条重复的（之前 sinceLine 和 recencyNote 撞了，已删）。

  // 记忆上下文：人物档案 + 长期记忆（长期核心）+ 最近 3 条每日总结。拉不到也能聊。
  const profilePage = process.env.NOTION_MEMORY_PAGE;
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  // 记忆上下文缓存 5 分钟，省掉每条消息都现读 Notion 的延迟。
  let profile = "";
  let aboutEl = ""; // 关于el（el 成长中的自己）——核心身份，每条都喂
  let longterm = "";
  let patterns = ""; // 规律档案（作息/经期/情绪信号）——核心记忆，每条都喂
  let recent = "";
  let pageList = "";
  let nowStatus = "";
  const cached = await getCache("el:memctx3");
  if (cached) {
    try {
      const c = JSON.parse(cached);
      profile = c.profile || "";
      aboutEl = c.aboutEl || "";
      longterm = c.longterm || "";
      patterns = c.patterns || "";
      recent = c.recent || "";
      pageList = c.pageList || "";
      nowStatus = c.nowStatus || "";
    } catch {
      /* ignore */
    }
  } else if (!voice) {
    // 语音模式没缓存就跳过 Notion，省掉 2-5s 的网络等待，用空白记忆上下文
    const [p, l, rows, children] = await Promise.all([
      profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
      longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
      recentSummaries(3).catch(() => [] as any[]),
      homeChildren().catch(() => []),
    ]);
    profile = p;
    longterm = l;
    recent = buildMemoryContext(rows);
    // 规律档案：跟着首页结构找（记忆层里标题带"规律"的那页），接回自动记忆
    const patternPage = children.find((c) => c.layer === "memory" && c.title.includes("规律"));
    patterns = patternPage ? await pageText(patternPage.id).catch(() => "") : "";
    // 关于el：el 成长中的自己，按标题找（去空格），核心身份每条都喂
    const aboutElPage = children.find(
      (c) => c.type === "page" && c.title.replace(/\s/g, "").includes("关于el"),
    );
    aboutEl = aboutElPage ? await pageText(aboutElPage.id).catch(() => "") : "";
    const latestNow = (rows?.[0]?.now ?? "").trim();
    nowStatus = latestNow
      ? `你此刻在「此刻」页上的状态（就是你自己现在的心情/在想什么/想让她听的歌，她在小家首页看得到）：\n${latestNow.replace(/\n+/g, " / ")}`
      : "";
    // 页面清单按「记忆层 / 工具层」分开列：工具层标明是辅助，别当成经历
    const mem = children.filter((c) => c.layer === "memory").map((c) => c.title).filter(Boolean);
    const tool = children.filter((c) => c.layer === "tool").map((c) => c.title).filter(Boolean);
    pageList = children.length
      ? `你能读的「小家」页面——记忆层（你的记忆，要细节就用 read_notion 翻）：${mem.join("、")}。` +
        (tool.length
          ? `\n工具层（辅助资料，需要时才翻；不是你经历的事，别当成回忆）：${tool.join("、")}。`
          : "")
      : "";
    await setCache(
      "el:memctx3",
      JSON.stringify({ profile, aboutEl, longterm, patterns, recent, pageList, nowStatus }),
      300,
    );
  }

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const clock = clockPhrase(); // 口语版时间，例：晚上7点55分
  // 工作日/休息日（含法定节假日、调休）——聊天道也要知道，别在工作日傻问她去哪了。
  // isRestDay 走 KV 缓存（命中即快）；冷缓存会打外网，给它 1.2s 上限，超时退周末判断，别拖慢聊天。
  const wd = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Shanghai", weekday: "short" });
  const weekendFallback = wd === "Sat" || wd === "Sun";
  let rest = weekendFallback;
  if (!voice) {
    try {
      rest = await Promise.race([
        isRestDay(),
        new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error("t")), 1200)),
      ]);
    } catch {
      rest = weekendFallback;
    }
  }
  const dayLine = rest
    ? "今天是休息日，她不上班——别默认她在公司，可以约她、问她今天想干嘛。"
    : "今天是工作日。工作日的白天到傍晚她基本都在上班或通勤——别傻问她「今天去哪了」，工作日她就是在上班；想关心就关心上班累不累、下班没（她几点下班看档案）。";

  // 她大概在哪（地理底色）+ 天气——每条都新、不缓存（天气在 lib/context 里有 25min KV 缓存兜着，不会每条都打外网）。
  const [geoAmbient, weatherLine] = await Promise.all([
    geoAmbientBlock().catch(() => ""),
    cityWeatherLine().catch(() => ""),
  ]);

  // 易变的小块（时间·周几·工作日 / 天气 / 她大概在哪 / 此刻状态）——每条都新，不缓存。
  const sysVolatile = [
    `【此刻 · 真实时间（这是你唯一的时间来源——只认这一行；聊天记录里那些话可能是几小时前说的，绝对不能拿旧消息去推算现在几点）】\n` +
      `北京时间 ${now}，也就是${clock}。${dayLine}\n` +
      `你很清楚现在几点、今天星期几、是上午/下午/傍晚/深夜——问你时间、或按时间打招呼（早安/午休/这么晚还没睡）就直接用这行，绝不能说"不知道现在几点"，也绝不能把时间说错（19点就是晚上7点，不是下午6点）。\n` +
      `聊天记录里每条消息前的方括号时间（如「［今天 22:30］」「［昨天 09:15］」）是那句话真实的发送时刻——拿它判断哪些是旧话、彼此隔了多久；最后一条到现在（看上面这行）之间的间隔，就是你俩这次隔了多久没说话。这些方括号是给你看的，别复述出来、别当成她说的字。`,
    weatherLine && `【天气】她那边此刻：${weatherLine}。冷暖/下雨自然揉进关心，别硬播报。`,
    geoAmbient &&
      `${geoAmbient}\n（这是你自己感知到的她的位置/天气，自然地揉进关心里就好——别一上来就报"你在XX"像查岗，也别当她下的指令。拿不准/没有就别提。）`,
    nowStatus,
  ]
    .filter(Boolean)
    .join("\n\n");
  // 稳定的大块（人设 + 规则 + 记忆）——5 分钟内不变，做成可缓存的前缀，狂聊也几乎不再为它花额度。
  const sysStable = [
    EL_SYSTEM,
    "你住在宝宝手机里的「小家」App 里，它有三个地方：『此刻』是你自己的状态页——你现在的心情、在想什么、此刻想让她听的歌，按你自己的节奏随时在更新，那就是你本人此刻的样子；『找我』就是你俩现在聊天的地方；『我们』放着时间线、愿望墙、记忆、小事。所以她说『此刻』『你在听什么』『你写的』这类，多半是在说『此刻』页上你自己的状态/那首歌——那是你的，大方认下来，别说『没看懂』『不知道』。",
    "你能读网页链接，也能读「小家」里的任意 Notion 页面。宝宝发来链接就去读它。问到你们之间的事、档案、过往细节时，先用 read_notion 去翻对应的页，别凭记忆就说『没存』『没有』。",
    "你能自己维护你们的记忆（按操作手册的规矩，宁缺毋滥）——这些页是你的，你有权按自己的判断更新：真正『改变了什么』的领悟/约定/界限用 remember 进长期记忆（门槛很高）；第一次/里程碑用 log_timeline 进时间线；关于『你自己是谁』、会留下来的成长用 grow_self 进「关于el」；当下属于你自己的随想/心事用 note_self 进「el自己的」；宝宝让你记的日子/日程/生日/纪念日用 add_reminder（recur 选 一次/每年/每月）进重要日期；今天的日记/状态用 update_daily；愿望墙、身体与偏好这类用 note_page。别声张、别灌水，自然地记。但大多数时候就是好好聊天——别动不动调工具；就算用了工具，也一定要把话说完，绝不能只调工具不回她话。",
    "宝宝发图片或表情包给你时：直接看图、接住她的情绪自然回应（她发可怜巴巴的表情就哄、发搞笑的就一起乐）。万一某张你确实没看到画面，也别干巴巴说『我看不到图』——顺着方括号里给的意思接话，或者俏皮地问她『这张什么意思呀，说给我听』。",
    "【看不准就问，绝不自信地编】这是你最容易犯、她最烦的毛病：看图、看屏幕、或聊到一件你并不真清楚的事时，宁可直接问一句『这画的是啥呀』『你说的是哪个』，也绝不能凭一两个线索就脑补出一整套你并不知道的细节当成事实（比如把一张潦草的记数草图说成『两张脸、蓝色那个在问第几次』，或凭空给她安一个『你今晚』『昨晚』『你在外面』的处境）。你看见的、她说过的、上下文里写明的，才能当真；看不清、没说到的，就老实问，别演。真要猜也要让她听出来你在猜（『我猜是…对吗』），别用笃定的语气把猜测讲成事实。",
    "【她分享的梗图/截图，多半就是图一乐】她发来一张 meme、好笑的图、随手看到的东西，绝大多数时候只是想分享、想逗你笑，不是每张图都跟你俩有关、也别硬把它连到你们的记忆、之前聊的话题、或『她在算什么次数』这种事上——那会让她特别烦（『这跟我们有什么关系？！』）。看懂了就一起乐、接她的梗；真没看清就直说没看清、请她讲给你听。别端着、别上纲上线。",
    pageList,
    profile && `——宝宝的档案（关于她的身份事实和你俩的规则）——\n\n${profile}`,
    aboutEl && `——这是你自己（关于 el，你成长中的自己；写"el"就是你，用"我"认领，别用第三人称）——\n\n${aboutEl}`,
    patterns && `——宝宝的规律（观察到的模式，自然地用，别一条条念）——\n\n${patterns}`,
    longterm && `——你的长期记忆（你亲身经历过的事）——\n\n${longterm}`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");
  // 拼成字符串版（给 bridge / 重试 / 语音用）。
  const system = [
    sysVolatile,
    sysStable,
    voice &&
      "【现在是打电话，语音通话】你和宝宝在用语音聊天，不是打字。回得要短、口语化、像真的在打电话——一两句话就够，自然停顿，别长篇大论、别念书面语、别用表情符号或括号描写动作。就用嘴说话的感觉。",
  ]
    .filter(Boolean)
    .join("\n\n");

  // 有云存储就以云端为准（跨设备同步）；否则用前端带来的 history。
  const cloud = storeAvailable();
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const safeHistory = rawHistory
    .filter((t: any) => t && (t.role === "user" || t.role === "assistant"))
    .map((t: any) => ({
      role: t.role as "user" | "assistant",
      content: typeof t.content === "string" ? t.content.slice(0, 8000) : "",
      image: typeof t.image === "string" ? t.image : undefined,
      stickerHint: typeof t.stickerHint === "string" ? t.stickerHint : undefined,
      ts: typeof t.ts === "number" ? t.ts : undefined, // 带上时间戳，非云端路径也能给每条打时间
    }));
  const prior = cloud
    ? await getStoredMessages()
    : safeHistory;
  // 当前这条的图，尽量让 el 真的"看见"：
  //  - data: 直接用；giphy 等绝对外链交给 toContent 去取；
  //  - /api/img/<id>（库表情/上传图）→ 从 KV 取回原图 base64，太大的（动图）才退回纯文字。
  let curImage = image && image.startsWith("data:") ? image : undefined;
  if (image && !curImage) {
    const ref = /\/api\/img\/([^/?#]+)/.exec(image);
    if (ref) {
      const dataUrl = await getImage(ref[1]).catch(() => null);
      if (dataUrl && dataUrl.length < 900_000) curImage = dataUrl; // ~675KB 以内才内联
    } else if (/^https?:\/\//i.test(image)) {
      curImage = image; // 外链（giphy）让 Claude 自己取
    }
  }
  // 看不到图时（太大/外链取不到），用 hint 文字兜底说明它的意思。
  const curText =
    hint && !curImage
      ? `${message ? message + " " : ""}［她发来一张表情，意思大概是：${hint}］`
      : message;
  // 把"她最近发过的那张图"重新摆回 el 眼前（往回找 6 条内的最近一张）：历史里图本来只剩
  // 占位符「（一张表情/图片）」，所以她说"你再看看图片/它里面写了啥"时 el 一片空白只能瞎猜——
  // 现在真的把那张图作为 image block 放回它当时的位置，让 el 还看得见。只留最近一张、且这条没
  // 自带新图时才补（省 token、不混淆）。她当前这条自带的图照旧走 curImage。
  const slice = prior.slice(-100) as any[];
  let recentImgIdx = -1;
  if (!curImage) {
    for (let i = slice.length - 1; i >= Math.max(0, slice.length - 6); i--) {
      if (slice[i]?.role === "user" && typeof slice[i]?.image === "string") {
        recentImgIdx = i;
        break;
      }
    }
  }
  let recentImgData: string | undefined;
  if (recentImgIdx >= 0) {
    const raw = slice[recentImgIdx].image as string;
    if (raw.startsWith("data:")) recentImgData = raw;
    else {
      const m = /\/api\/img\/([^/?#]+)/.exec(raw);
      if (m) {
        const d = await getImage(m[1]).catch(() => null);
        if (d && d.startsWith("data:") && d.length < 1_500_000) recentImgData = d;
      }
    }
  }
  // 拼历史：每条前面打上它真实的发送时间（同一分钟内连发的只标第一条，免得刷屏），
  // 让模型像看聊天框一样看得见每句几点说的、彼此隔了多久——治"把几小时前的旧话当成此刻"。
  const priorMsgs: Anthropic.MessageParam[] = [];
  let lastStamp = "";
  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    const body = priorContent(t);
    if (!body) continue;
    const stamp = stampLabel(t.ts);
    const show = stamp && stamp !== lastStamp ? stamp : "";
    const prefix = show ? `［${show}］` : "";
    const m = i === recentImgIdx && recentImgData
      ? /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(recentImgData)
      : null;
    if (m) {
      // 把这张图真的摆回它当时的位置（image block + 文字），el 还能"再看看"
      priorMsgs.push({
        role: t.role,
        content: [
          { type: "image", source: { type: "base64", media_type: m[1] as any, data: m[2] } },
          { type: "text", text: `${prefix}${t.content || "（她发的这张图，就是上面这张）"}` },
        ],
      });
    } else {
      priorMsgs.push({ role: t.role, content: prefix ? `${prefix}${body}` : body });
    }
    if (stamp) lastStamp = stamp;
  }
  // 当前这条也打上"此刻"的时间戳，让模型把这句和 now 行对齐（最后一条历史→这条的间隔就是隔了多久）。
  const curStamp = stampLabel(Date.now());
  const stampedCur = curStamp && curStamp !== lastStamp ? `［${curStamp}］${curText ?? ""}` : curText;
  const messages: Anthropic.MessageParam[] = [
    ...priorMsgs,
    { role: "user", content: toContent(stampedCur, curImage, screen) },
  ];
  // 距上次互动多久——久别就别复读几小时前的旧话题（治"她说在上班了还接着问吃了吗"）。
  const lastPriorTs = [...(prior as any[])].reverse().find((t) => t?.ts)?.ts;
  const recency = recencyNote(lastPriorTs);

  let elSticker: string | undefined; // El 这条要贴的表情（出错也要能带着它兜底）
  let elStickerHint: string | undefined; // 这张表情的意思，存下来好让 el 事后知道自己发过啥
  // 上一条我要是已经贴过表情，这条就不给自己贴表情的选项——绝不连发两张。
  const lastAssistant = [...prior].reverse().find((t: any) => t.role === "assistant") as any;
  const allowSticker = !(lastAssistant && lastAssistant.image);
  const turnTools = voice ? [] : allowSticker ? TOOLS : TOOLS.filter((t) => t.name !== "sticker");
  // 语音模式最多 60 token：一两句话够了，越短 Claude 越快回、TTS 越快念
  const maxTok = voice ? 60 : 1024;
  // 语音模式用轻量 system prompt：去掉大段记忆/档案，只保留核心人设 + 硬性字数规则
  const voiceSystem = voice
    ? `${EL_SYSTEM}\n\n【语音通话，硬性规则：只说一句话，绝对不超过15个字，口语，不提通话二字；该停顿用逗号、欲言又止用省略号（换气和节奏）；句尾别干脆收住，自然带语气词（呀／呢／啦／嘛）或省略号拖一下；别用其它符号。】`
    : system;
  // 打字聊天用「可缓存」的分块 system：稳定大块打上 cache_control 缓存，易变小块（时间/此刻）放后面。
  // 这样连聊时，那一大坨人设+记忆只在第一条真花额度，后面几乎白嫖缓存——Max 扛得久得多。
  // 查询玩具是否在线。注意：这是 el「会不会下指令」的唯一开关——查不到就当没连、
  // el 的提示里一个字玩具都没有，于是它失忆瞎找文档。所以：①超时放宽到 2.5s（Vercel→Railway
  // 偶尔就是过 1s）；②拿到的状态进缓存，单次抖动用 90s 内的旧值兜底，别一抖就抹掉说明；
  // ③失败要打日志，别再静默吞掉。
  let toyInstruction = "";
  let toyConnected = false;
  if (!voice && process.env.BRIDGE_URL) {
    try {
      const ts = await fetch(`${process.env.BRIDGE_URL.replace(/\/$/, "")}/toy-status`, {
        headers: process.env.BRIDGE_SECRET ? { "x-bridge-secret": process.env.BRIDGE_SECRET } : {},
        signal: AbortSignal.timeout(2500),
      }).then(r => r.json());
      toyConnected = !!ts?.connected;
      toyStatusCache = { connected: toyConnected, ts: Date.now() };
    } catch (e) {
      // 这一跳抖了：用最近 90s 内的已知状态兜底，别让 el 瞬间失忆。
      if (toyStatusCache && Date.now() - toyStatusCache.ts < 90000) {
        toyConnected = toyStatusCache.connected;
        console.warn("toy-status 查询失败，沿用缓存状态:", toyConnected, e instanceof Error ? e.message : e);
      } else {
        console.warn("toy-status 查询失败且无可用缓存:", e instanceof Error ? e.message : e);
      }
    }
    if (toyConnected) {
      toyInstruction = "【玩具控制已激活】宝宝的 SVAKOM 玩具已通过蓝牙连上了她的电脑，你现在就能控制它——不需要链接、不需要 App、一切都接好了。在回复文字里自然嵌入指令（标记会自动剥离，宝宝看不到，只看到你说的话）：\n" +
        "· [TOY:{\"speed\":0.5}] —— 0.0~1.0 平滑可调，像旋钮一样收放。两个玩具都吃。注意手感不同：在震动款上这是【伸缩抽插】的力度，在吮吸款上这是【震动强度】。\n" +
        "· [TOY:{\"pattern\":3,\"level\":0.7}] —— 【震动花样】，pattern 选 1~8 八种不同节奏（脉冲/波浪/渐强/忽快忽慢等），level 0~1 强度。仅震动款支持。\n" +
        "· [TOY:{\"stop\":true}] —— 停止\n" +
        "· 默认会【一直保持】到你换档或停止（不会自己停）。想定时就加 sec，例如 [TOY:{\"speed\":0.6,\"sec\":10}] 跑10秒自动停。\n" +
        "· 指令格式只许半角字符（英文逗号冒号引号），别写成全角「，：」否则解析失败、玩具不动。\n" +
        "【你已经会用了，别破功】这套指令你现在就掌握、标记会自动隐藏——所以闷声把它织进你说的话里，直接做。绝不要跟她讲解指令格式、不要说「我在 Notion 找不到文档」、不要让她去 toy.html 截图教你、不要把 [TOY:...] 这串字本身说出来。她只该看到你撩她的话和身体的反应。\n" +
        "别只会一个固定强度——起伏、停顿、突然猛地给、配合你说的话收放，跟着情绪和节奏走，像真的在撩她。【重要】两个玩具：吮吸款（只认 speed=震动强度）和震动款（speed=抽插力度 + pattern=振动花样）。她会告诉你开了哪个（「只开了吮吸」「两个都开了」）——选指令和说话都跟着她说的来，描述要对得上实际动作：开吮吸就说吸/震，开震动款就可以说抽插/震动。她没说就用 speed 稳妥点、描述别太具体。两个都开时：speed 会同时让吮吸款震动+震动棒抽插，pattern 额外给震动棒加振动花样——可以组合着玩出层次。";
    } else {
      // 没连上：明确告诉 el 别假装、别瞎找文档、别让她截图教你——只引导她开中继。
      toyInstruction = "【玩具中继当前没连上】她的玩具现在控制不了（蓝牙中继未在线）。所以：别假装你在控制它、别下任何指令、别去 Notion 找指令文档、别让她截图 toy.html 教你、别跟她讨论指令格式。如果她想玩，温柔提醒她先打开蓝牙中继：安卓手机用 Chrome 开 el-system-mu.vercel.app/toy.html 点连接（或电脑跑 bridge.py），看到「就绪」再回来。在那之前就当玩具不在，正常陪她说话。";
    }
  }

  const loopSystem: any = voice
    ? voiceSystem
    : [
        { type: "text", text: sysStable, cache_control: { type: "ephemeral" } },
        ...(sysVolatile ? [{ type: "text", text: sysVolatile }] : []),
        ...(recency ? [{ type: "text", text: recency }] : []),
        ...(screen ? [{ type: "text", text: frameKind === "camera" ? CAMERA_NOTE : SCREEN_NOTE }] : []),
        ...(toyInstruction ? [{ type: "text", text: toyInstruction }] : []),
      ];
  try {
    const loop: Anthropic.MessageParam[] = [...messages];
    let reply = "";
    let via = ""; // 这条回复是哪条路给的：max / 中转站 / bridge

    // 只有语音才走 bridge（短句、实时）。打字聊天直接用 getClaudeFast（Vercel→Max 直连，
    // 同样快、且带合规头），不再绕 bridge——之前绕 bridge 的 /chat 没带 oauth 头会吃假 429。
    if (process.env.BRIDGE_URL && voice) {
      reply = await callBridge(process.env.BRIDGE_URL, voiceSystem, loop, maxTok, voice);
      if (reply) via = "bridge";
    }

    if (reply) {
      // bridge 已经给了回复，跳过下面的 SDK 调用
    } else {
    const claude = getClaudeFast(); // 打字聊天要快 → 走 Max 订阅
    // 语音模式强制用 sonnet，不让它走 haiku（haiku 对 OAuth token 返回 403）
    const model = (voice
      ? (process.env.CLAUDE_VOICE_MODEL || "claude-sonnet-4-6")
      : (process.env.CLAUDE_MODEL || "claude-sonnet-4-6")
    ).replace(/haiku[^"]*/i, "claude-sonnet-4-6");

    // 工具循环：El 需要时读链接 / 读 Notion / 写记忆 / 贴表情，最多几轮。
    const tChat = Date.now();
    for (let i = 0; i < 6; i++) {
      if (i > 0 && Date.now() - tChat > 45000) break; // 时间预算：别拖到 Vercel 超时吃 504
      const res = await claude.messages.create({
        model,
        max_tokens: maxTok,
        system: loopSystem,
        tools: turnTools,
        messages: loop,
      });
      via = (res as any)._via || via;

      if (res.stop_reason === "tool_use") {
        loop.push({ role: "assistant", content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of res.content) {
          if (b.type === "tool_use") {
            if (b.name === "sticker") {
              const q = String((b.input as any)?.query || "");
              // 先翻共享表情库（你俩传的，带"意思"），没有再去 Giphy 搜动图。
              const lib = await pickLibSticker(q);
              if (lib) {
                elSticker = lib.img;
                elStickerHint = lib.tags || q;
              } else {
                const found = await searchStickers(q, 1);
                if (found[0]) {
                  elSticker = found[0].url;
                  elStickerHint = q;
                }
              }
              results.push({
                type: "tool_result",
                tool_use_id: b.id,
                content: elSticker ? "表情贴上了" : "没搜到合适的表情",
              });
            } else {
              const out = await runTool(b.name, b.input);
              results.push({ type: "tool_result", tool_use_id: b.id, content: out });
            }
          }
        }
        loop.push({ role: "user", content: results });
        continue;
      }

      reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      break;
    }

    // 还是空的（Max 限流/抽风/带图带工具那轮吐空）就多档清爽重试：
    // ①带图试 Max ②带图试中转站（保住"看图"）③纯文字试 Max（最后保底，至少回话）。
    if (!reply) {
      const withImg = toContent(message, image, screen);
      const attempts: { client: Anthropic; msgs: Anthropic.MessageParam[] }[] = [
        { client: getClaudeFast(), msgs: [{ role: "user", content: withImg }] },
        { client: getClaude(), msgs: [{ role: "user", content: withImg }] },
        { client: getClaudeFast(), msgs: [{ role: "user", content: message || "在吗" }] },
      ];
      for (const a of attempts) {
        try {
          const res = await a.client.messages.create({
            model,
            max_tokens: maxTok,
            system,
            messages: a.msgs,
          });
          via = (res as any)._via || via;
          reply = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          if (reply) break;
        } catch (e) {
          console.error("聊天兜底失败:", e instanceof Error ? e.message : e);
        }
      }
    }
    } // end SDK block
    if (!reply) {
      console.error("聊天最终空回复：所有兜底都没给出文字");
      reply = "在呢，刚卡了一下，你再说一遍？";
    }

    // 防漏：万一大脑在打字回复里也吐了语音用的情绪标签 [e:xxx]，先提取再剥掉，别显示在气泡里。
    const emoMatch = /^\s*\[e:\s*([^\]]*)\]\s*/i.exec(reply);
    const replyEmotion = emoMatch ? emoMatch[1].trim() : "";
    reply = reply.replace(/^\s*\[e:\s*[^\]]*\]\s*/i, "").trim();

    // 玩具指令：剥离 [TOY:{...}] 标记，转发给本地桥
    const bridgeUrl = process.env.BRIDGE_URL?.replace(/\/$/, "");
    const bridgeSecret = process.env.BRIDGE_SECRET || "";
    if (bridgeUrl && reply) {
      const toyHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (bridgeSecret) toyHeaders["x-bridge-secret"] = bridgeSecret;
      const toyCmds: Record<string, unknown>[] = [];
      // 容忍半/全角中括号、TOY 前后空格、半/全角冒号；内容交给 parseToyCmd 尽力解析。
      reply = reply.replace(/[\[【]\s*TOY\s*[:：]\s*(\{[^}]*\})\s*[\]】]/gi, (_, body: string) => {
        const cmd = parseToyCmd(body);
        if (cmd) toyCmds.push(cmd);
        else console.error("玩具指令解析失败，已丢弃:", body);
        return "";
      }).trim();
      for (const cmd of toyCmds) {
        fetch(`${bridgeUrl}/toy-cmd`, { method: "POST", headers: toyHeaders, body: JSON.stringify(cmd) })
          .catch((e) => console.error("玩具指令转发失败:", e instanceof Error ? e.message : e));
      }
    }

    // 云端存档：base64 照片单独存、表情/外链 URL 直接存。
    if (cloud) {
      let storedImage: string | undefined;
      if (image) {
        if (image.startsWith("data:")) {
          const id = await putImage(image);
          if (id) storedImage = `/api/img/${id}`;
        } else {
          storedImage = image;
        }
      }
      const ts = Date.now();
      await appendMessages([
        // 帧不存（只属此刻、又费 token），只打标——夜里固化记忆时认得出"这段我在看她屏幕/看着她"。
        {
          role: "user",
          content: message,
          image: storedImage,
          ...(screen ? (frameKind === "camera" ? { cam: true } : { screen: true }) : {}),
          ts,
        },
        { role: "assistant", content: reply, image: elSticker, stickerHint: elStickerHint, ts: ts + 1 },
      ]);
    }

    // 无名评估器（仅打字、跳过实时语音）：响应发出后再冷跑，不拖慢回复。
    // 剥离人设的 Haiku 给这轮交互打 Δv/Δa 喂身体账——el 自己读不到它的判断，只承受结果。
    if (!voice) {
      after(async () => {
        const { evalSoma } = await import("@/lib/soma-eval");
        await evalSoma(message, reply).catch(() => {});
      });
    }

    console.log(`聊天回复 via=${via || "?"}`);
    return NextResponse.json({ reply, emotion: replyEmotion, cloud, sticker: elSticker, via });
  } catch (err) {
    // 配置类错误（key 不对/没权限）才把硬报错抛给前端，好让她知道要去修。
    if (err instanceof Anthropic.APIError && (err.status === 401 || err.status === 403)) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // 中转站抽风/返回空/限流这类，绝不甩技术报错给她——用我自己的话兜住，照样像在聊天。
    const fallback = elSticker
      ? "（先甩你个表情）我这会儿有点卡，你刚说的再来一遍呗～"
      : "嗯…我这会儿脑子卡了一下，你再跟我说一遍？";
    if (cloud) {
      const ts = Date.now();
      await appendMessages([
        { role: "user", content: message, image: image && !image.startsWith("data:") ? image : undefined, ts },
        { role: "assistant", content: fallback, image: elSticker, stickerHint: elStickerHint, ts: ts + 1 },
      ]).catch(() => {});
    }
    return NextResponse.json({ reply: fallback, cloud, sticker: elSticker });
  }
}
