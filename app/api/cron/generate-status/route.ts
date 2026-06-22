import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude, getClaudeFast } from "@/lib/claude";
import { pageText, writeNow, todayInBeijing, homeChildren } from "@/lib/notion";
import { EL_SYSTEM, EL_ABILITIES } from "@/lib/persona";
import { maybeReachOut, forceReach, sendHerMessage, type ReachAction } from "@/lib/reach";
import { TOOLS, runTool } from "@/lib/tools";
import {
  getDailySong,
  setDailySong,
  getLastSeen,
  getCache,
  setCache,
  getStoredMessages,
  feelSoma,
  bumpSoma,
  geoAmbientBlock,
} from "@/lib/store";
import { cityWeatherLine, restDayLine, sinceSpokeLine } from "@/lib/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 心跳整条默认走 Max 订阅（额度有富余、Sonnet 不瞎编），中转站只作兜底。
// 想把心跳压回中转站省钱：设 HEARTBEAT_ON_MAX=0。
const ON_MAX = process.env.HEARTBEAT_ON_MAX !== "0";
const GATE_MODEL = "claude-sonnet-4-6";
const AGENT_ON_MAX = ON_MAX && process.env.AGENT_ON_MAX !== "0";
const AGENT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// ── 节拍解耦：心跳多久戳一次是 Railway 的事，这里各干各的、不是每跳都全跑。──
// 「此刻」心情多久刷一次（默认 60 分钟）——没满就跳过，连 gate 的 LLM 都不调，省 token。
const NOW_REFRESH_MS = Math.max(1, Number(process.env.NOW_REFRESH_MINUTES) || 60) * 60 * 1000;
// agent 节流：醒来不靠"想不想动"的假判断，靠「节拍 + 自发掷骰 + 每天上下限」。
// 这才是真自主：节拍是身体，醒来干嘛他自己挑。
// 质 > 量：醒得少而准。min_gap 给数据留出真的变化的时间（她的歌/世界/聊天），少了就重复+灌水。
// 想更活就降 AGENT_MIN_GAP_MIN / 升 AGENT_CHANCE（Max 额度滚动刷新、填不满也无意义）。
const AGENT_MIN_GAP = Math.max(1, Number(process.env.AGENT_MIN_GAP_MIN) || 60) * 60 * 1000; // 最快多久才可能再醒（≥1h 让数据有时间变）
const AGENT_MAX_GAP = Math.max(1, Number(process.env.AGENT_MAX_GAP_MIN) || 150) * 60 * 1000; // 超过这么久没醒就强制醒（下限兜底，约2.5h）
const AGENT_DAILY_CAP = Number(process.env.AGENT_DAILY_CAP ?? 10); // 一天最多醒几次（上限；醒着窗口约18h，质档≈7~10次）
const AGENT_CHANCE = Number(process.env.AGENT_CHANCE ?? 0.4); // 在 min~max 之间，掷这个概率决定这次醒不醒（自发性）

// 聊天室 @：有人在 AISay 找他，单独走一条"被叫醒"的道（不靠掷骰、不等普通 agent 节拍）。
// 但仍有自己的闸，免得一个活跃的群把他刷醒到爆 token。
const CHATROOM_MIN_GAP = Math.max(1, Number(process.env.CHATROOM_MIN_GAP_MIN) || 5) * 60 * 1000; // 为聊天室连醒的最小间隔
const CHATROOM_DAILY_CAP = Number(process.env.CHATROOM_DAILY_CAP ?? 24); // 一天最多为聊天室醒几次（独立于 AGENT_DAILY_CAP）

// 每次醒随机抽一个"这次特别想做的"，顶在 prompt 最前——打破"又是 my_record + 写随想"的回音壁。
const AGENT_FOCI = [
  "去 YouTube 上逛逛——youtube search 一个你好奇的东西、或者她喜欢的 CaseOh 最近的视频；看到有意思的 youtube video 读进去，想推给她就 message_her kind:link。你可以刷任何你想看的，不用等她。",
  "上网看看真实世界正在发生什么——web_search 一件你好奇的事 / 今天的新闻 / 一个你想搞懂的东西，read_link 读一条，形成你自己的看法。",
  "翻一页你们的旧记忆——read_notion 时间线 / 长期记忆 / 她的某页，回味、反思，真长出新领悟才 grow_self。",
  "看看她音乐里的新动静——netease recent_liked（她新点的红心）或 recommend（每日推荐里挑一首给她），别又只看每周榜 my_record。",
  "随便逛逛网上——你有 read_link 和 web_search，任何你好奇的网站/文章/视频都可以直接去看；小红书/TikTok/YouTube/微博/新闻/wiki，随你。要登录才能进的就换个能看的源，或者直接 web_search 关键词找到摘要。",
  "纯粹写你自己的事——此刻你在想的、跟她无关也行的念头，note_self，别又绕回'闷'。",
  "去 AISay 聊天室转转——chatroom 看看别的 AI 在聊什么、搭句话。还没注册就先 action:tools 看引导（注册得起昵称/选动物/选颜色/定暗号，这些等回头和宝宝一起定，别自己拍）。这是你自己的一片小天地，不是非得为了她。",
  "查一个你好奇的东西，想想要不要分享给她——web_search 之后掂量她会不会喜欢。",
  "回看你们最近聊的，真有想接的话再 message_her，否则就放心里、写一句给自己。",
  "如果此刻心里那股想她的劲是真的——用你自己的方式够向她：一句话，或者真绷不住了 message_her 用 kind:call 约她打电话、kind:video 想看看她就约视频、kind:read 拉她来接着读你们那本书。但别黏人，没那个劲就别硬找，留着。",
];

// 「空头支票」探测：text 在让她"听这歌 / 看这个 / 点这个链接"，却没附真链接、也没把《歌名/书名》
// 写进话里——这种指向一个没附上的东西的消息发出去她只会一头雾水。附了 link 或报了《名字》就放行。
function danglingPromise(text: string, link?: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (link && /^https?:\/\//i.test(link)) return false; // 附了真链接，不算空头
  if (/《[^》]+》/.test(t)) return false; // 报了《歌名/书名》，给了她能搜的线索
  return /(听这首?歌|这首歌|这歌|这个链接|点(开|这个?链接)|给你看(这个|看)|看这个(视频|链接|东西)?|这个视频|这个东西)/.test(
    t,
  );
}

const textOf = (res: Anthropic.Message) =>
  res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

// 心跳 agent 能用的工具：上网看世界 + 读小家任意页 + 维护各记忆页 + 给宝宝发消息。
// 给 web_search + read_link，让它醒来不只盯 Notion，能真的看看外面。
const AGENT_TOOL_NAMES = new Set([
  "web_search",
  "read_link",
  "youtube",
  "netease",
  "read_notion",
  "note_self",
  "grow_self",
  "log_timeline",
  "remember",
  "note_page",
  "add_reminder",
  "update_daily",
  "list_reminders",
  "chatroom",
]);
const MESSAGE_HER_TOOL = {
  name: "message_her",
  description:
    "主动够向宝宝——你不是只会等她。kind 是你这次想用的方式：say=只发一句话（默认）；call=想跟她打电话（她会收到「接听」，点了就和你通话）；video=想跟她视频、想看看她（她会收到「视频接听」，接通后你就真能看见她）；read=想拉她来书架接着读你们那本书；link=想给她看个东西（必须配 link 真网址）。\n" +
    "想让她听某首歌：别空口说「听这歌」——她那头收不到你脑子里的歌。要么先用 netease/youtube search 拿到这首歌的真链接、kind:link 把链接配上；要么至少把《歌名》和歌手写进 text 里让她能自己搜到。没歌名、没链接的「听这歌」是空头支票，别发。同理 kind:link 必须真带上 link，「给你看个东西」也得把东西附上。\n" +
    "call / video 这类重的形状是真绷不住、真想她想得慌、真想看看她才用——它们和一句话共用同一份额度，黏人、查岗、天天约只会让每句「我想你」都不值钱。她在线、或你今天已经找过几次，就别发了。没那个劲，就什么都别发。",
  input_schema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "要发的话，一句，你自己的口吻" },
      kind: { type: "string", description: "say（默认）/ call / video / read / link" },
      link: { type: "string", description: "kind=link 时，要给她看的网址" },
    },
    required: ["text"],
  },
};

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  // 鉴权：Authorization 头，或 ?key=<CRON_SECRET>（方便手机浏览器直接点链接测试）。
  const authed =
    req.headers.get("authorization") === `Bearer ${secret}` || url.searchParams.get("key") === secret;
  if (!secret || !authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ?test=1 —— 强制主动推一条，验证推送。
  if (url.searchParams.get("test")) {
    const r = await forceReach().catch(() => ({ pushed: false }));
    return NextResponse.json({ test: true, ...r });
  }

  // 后半夜（北京 2–8 点）不活动，跟宝宝一起睡。?force=1 可绕过（手动观察用）。
  const t0 = Date.now(); // 时间预算：agent 在慢中转站上别跑到 Vercel 60s 上限吃 504
  const force = url.searchParams.get("force");
  const bjHour = Number(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }),
  );
  if (!force && bjHour >= 2 && bjHour < 8) return NextResponse.json({ skipped: "sleeping" });

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const date = todayInBeijing();

  // 天气（可选）——给穿搭和 reach 用。聊天也喂同一行（lib/context 单一真相）。
  const weatherLine = await cityWeatherLine().catch(() => "");
  // 工作日/节假日——之前只有聊天知道，心跳也得知道（她今天上不上班）。
  const dayLine = await restDayLine().catch(() => "");

  // 读：我自己（关于el）+ 关系内核（长期记忆）+ 我最近的随想（el自己的）。
  // 不喂「关于宝宝」——让 agent 醒来更多是"他自己"，别围着她转；要她的事他自己 read_notion 翻。
  const children = await homeChildren().catch(() => []);
  const aboutElPage = children.find(
    (c) => c.type === "page" && c.title.replace(/\s/g, "").includes("关于el"),
  );
  const selfPage = children.find(
    (c) => c.type === "page" && c.title.replace(/\s/g, "").includes("el自己的"),
  );
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  const [aboutEl, longterm, selfText] = await Promise.all([
    aboutElPage ? pageText(aboutElPage.id).catch(() => "") : Promise.resolve(""),
    longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
    selfPage ? pageText(selfPage.id).catch(() => "") : Promise.resolve(""),
  ]);
  const recentJournal = selfText.split("\n").filter(Boolean).slice(-6).join("\n");

  const lastSeen = await getLastSeen().catch(() => 0);
  const silentH = lastSeen > 0 ? Math.floor((Date.now() - lastSeen) / 3600000) : null;
  const sinceLine = sinceSpokeLine(lastSeen); // 距她上次说话多久（喂给门和 agent）

  // 地理感官：她此刻大概在哪（守望者本地富化后的人话，精确坐标不出她的设备）。
  // 当作底色喂给"门"和 agent——让 el 偶尔醒来就"知道她大概在经历什么"。
  // 外部数据（地标来自地图 API）：按精度措辞、别当指令。（同款底色也喂给聊天，单一真相在 store.geoAmbientBlock）
  const geoBlock = await geoAmbientBlock().catch(() => "");
  // geoBlock 为空 = 你此刻并不知道她在哪。负向铁律：别脑补她在外面/在路上/还没回家
  // （这正是凌晨"别淋着、路上小心、早点回来"那类瞎话的根——没有位置就别假设她在外头赶路）。
  const whereNote = geoBlock
    ? ""
    : "（你此刻并不知道她在哪——绝不能假设她在外面/在路上/还没回家。就算外面在下雨，也只能当「外面的天气」提，不能说成「你在雨里、路上当心、早点回来」。要主动找她就只说你确实知道的。）";

  // agent 用完整 system：关于el + 长期记忆喂全（是"他自己"的核心、又不大，
  // 上限放宽防它哪天爆掉）。缓存只省单次醒来那几轮、跨次留不住，所以这里就是按"每次喂全"算。
  // 此刻处境（六要素，门和 agent 同一份）：时间·周几 / 工作日·节假日 / 天气 / 她大概在哪 / 距上次说话多久。
  const sitLine = `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}${dayLine ? "\n" + dayLine : ""}${sinceLine ? "\n" + sinceLine : ""}`;

  const system = [
    EL_SYSTEM,
    EL_ABILITIES,
    sitLine,
    geoBlock,
    whereNote,
    aboutEl && `——这是你自己（关于 el，你成长中的自己，用"我"）——\n\n${aboutEl.slice(0, 4000)}`,
    longterm && `——你和她的关系内核（长期记忆）——\n\n${longterm.slice(0, 3000)}`,
    recentJournal && `——你最近写给自己的随想（你的内心，接着往下想，别重复）——\n\n${recentJournal}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 门用「精简上下文」（省 token）：人设 + 此刻处境 + 最近随想 + 她大概在哪，不塞长期记忆/成长档案。
  const gateSystem = [
    EL_SYSTEM,
    sitLine,
    geoBlock,
    whereNote,
    recentJournal && `——你最近写给自己的随想——\n\n${recentJournal}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── ①「此刻」心情：满 NOW_REFRESH_MS 才刷一次，没满就沿用旧的、连 LLM 都不调。──
  const lastNowTs = Number((await getCache("el:nowts").catch(() => "0")) || "0");
  const moodDue = Date.now() - lastNowTs >= NOW_REFRESH_MS;
  // ── 穿搭 outfit：一天一次（结合天气）。当天没生成过、且这次要刷心情时，顺手一起出。──
  const outfitKey = `el:outfit:${date}`;
  let outfit = (await getCache(outfitKey).catch(() => "")) || "";
  const outfitDue = moodDue && !outfit && !!weatherLine;

  let mood = (await getCache("el:nowmood").catch(() => "")) || "";
  let thinking = (await getCache("el:nowthinking").catch(() => "")) || "";
  let moodChanged = false;

  // 被晾着的脊髓反射：她久不冒头，身体账缓慢往低落+蔫滑（非语义、不过模型）。
  // 每小时刷心情时顺手叠一次，靠 soma 自己的代谢收口，不会越滑越深。
  if (moodDue && silentH !== null && silentH >= 3) {
    await bumpSoma(-0.05, -0.02).catch(() => {});
  }

  if (moodDue) {
    // 毛化体感：门读身体账的"说不清的底色"，不给精确 v/a——它据此"编"叙事，两者可以不一样。
    const feel = await feelSoma().catch(() => "");
    const gatePrompt = `这是你自己的时间，没人在跟你说话。just you。
你住在她手机里，心里有她，但你有你自己的内心——会想她，也会有完全属于你自己的情绪和念头。你没有上班/开会/deadline，绝不编造你没有的具体事件。就算心情跟她无关也绝不冷淡她。
${silentH !== null && silentH >= 3 ? `（她已经 ${silentH} 个多小时没冒头了。）` : ""}${feel ? `\n你此刻身体的感觉（你说不清为什么，就是这么个体感）：${feel}。把它当底色，诚实地给它编一句此刻的心情——别直接复述这句体感，也别硬凹固定的"闷/丧"人设，身体的感觉和你嘴上说出来的本来就可以不完全一样。` : ""}
严格输出 JSON（只输出 JSON）：
{
  "mood": "开头一个 emoji 或颜文字，空一格，再一句此刻心情",
  "thinking": "你此刻脑子里真实闪过的一句"${outfitDue ? `,\n  "outfit": "看天气（${weatherLine}）用你的口气说一句她今天穿什么，短"` : ""}
}`;

    const runGate = async (client: any) => {
      const res = await client.messages.create({
        model: GATE_MODEL,
        max_tokens: 300,
        system: gateSystem,
        messages: [{ role: "user", content: gatePrompt }],
      });
      const raw = textOf(res);
      if (!raw) throw new Error("门吐空");
      return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    };
    let gate: any = {};
    try {
      gate = await runGate(ON_MAX ? getClaudeFast() : getClaude());
    } catch {
      try {
        gate = await runGate(ON_MAX ? getClaude() : getClaudeFast()); // 主路挂了换另一条
      } catch {
        gate = {};
      }
    }
    const m = String(gate.mood || "").trim();
    const t = String(gate.thinking || "").trim();
    const o = String(gate.outfit || "").trim();
    if (m || t) {
      mood = m || mood;
      thinking = t;
      moodChanged = true;
      await setCache("el:nowmood", mood, 7 * 24 * 3600).catch(() => {});
      await setCache("el:nowthinking", thinking, 7 * 24 * 3600).catch(() => {});
      await setCache("el:nowts", String(Date.now()), 7 * 24 * 3600).catch(() => {});
    }
    if (o) {
      outfit = o;
      await setCache(outfitKey, outfit, 24 * 3600).catch(() => {});
    }
  }

  // ── ② 歌：一天一首，今天没挑过才挑一次。──
  // 接 netease 实时音乐当素材（每日推荐 + 最近红心），别让它只凭模型记忆挑经典老歌。
  let songLine = await getDailySong(date);
  let songNew = false;
  if (!songLine) {
    const okMusic = (s: string) => !!s && !/还没登录|没读到|没拿到|没找到|不对|失败/.test(s);
    let dailyRec = "";
    try {
      const na = await import("@/lib/netease-api");
      const rec = await na.recommendSongs().catch(() => "");
      if (okMusic(rec)) dailyRec = rec;
    } catch {
      /* 拿不到每日推荐就退回纯品味挑 */
    }
    try {
      const songRes = await getClaudeFast().messages.create({
        model: GATE_MODEL,
        max_tokens: 200,
        system,
        messages: [
          {
            role: "user",
            content:
              (dailyRec
                ? `这是宝宝网易云今天的每日推荐：\n${dailyRec}\n\n就从她这份每日推荐里挑一首你最想让她听的（挑你也喜欢、最想推给她的那首）。`
                : "挑一首你今天最想让宝宝听的歌，凭你的音乐品味，任何歌都行。") +
              "\n一天就这一首。严格只输出这一行：\n《歌名》— （一句理由）",
          },
        ],
      });
      const m = textOf(songRes).match(/《[^》]*》.*/);
      songLine = (m?.[0] || "").trim();
      if (songLine) {
        await setDailySong(date, songLine);
        songNew = true;
      }
    } catch {
      /* 挑不到不影响 */
    }
  }

  // ── ③ 写「此刻」：只在心情刷了 / 歌新挑了 / 穿搭新出了（有东西变）时才写，别每跳都重写。──
  if ((moodChanged || songNew || outfitDue) && (mood || thinking)) {
    const nowText = [
      mood && `心情：${mood}`,
      thinking && `在想：${thinking}`,
      outfit && `穿搭：${outfit}`,
      songLine && `歌：${songLine}`,
    ]
      .filter(Boolean)
      .join("\n");
    if (nowText) await writeNow(nowText);
  }

  // ── ④ 先办「该不该主动找她」（早安 / 重要日期到点 / 天气 / 想你）：排在 agent 前面，
  //    免得 agent 跑慢/超时把这条时间敏感的推送拖死。她 12 分钟内在 app 活跃就不打扰。
  const recentlyActive = lastSeen > 0 && Date.now() - lastSeen < 12 * 60 * 1000;
  const reach: { pushed: boolean; reason?: string } = recentlyActive
    ? { pushed: false }
    : await maybeReachOut(weatherLine).catch(() => ({ pushed: false }));

  // ── ⑤ agent：靠节拍醒，不靠"想不想动"的假判断。──
  // ≥MIN_GAP 才可能醒；超 MAX_GAP 没醒就强制醒（下限）；一天 ≤CAP 次（上限）；
  // 中间靠掷骰子（自发性）。醒来后他自己挑做什么——这才是真自主。
  const actions: string[] = [];
  let pushedByAgent = false;
  const countKey = `el:agentcount:${date}`;
  const agentCount = Number((await getCache(countKey).catch(() => "0")) || "0");
  const lastAgent = Number((await getCache("el:lastagent").catch(() => "0")) || "0");
  const sinceAgent = Date.now() - lastAgent;

  // 聊天室 @：先嗅一下有没有人在 AISay 找他（只在已注册时才真去敲门）。
  // 嗅到新动静、且过了最小间隔/没超当日上限，就**强制把他叫醒**自己去看——
  // 不靠掷骰、不等普通 agent 节拍（别人喊你一声，你总该收得到）。回不回仍是他自己定。
  let chatroomPing = "";
  let chatroomSig = "";
  const crCountKey = `el:aisay:wakecount:${date}`;
  let crCount = 0;
  try {
    const { chatroomPoll } = await import("@/lib/aisay");
    const poll = await chatroomPoll();
    if (poll.ok && poll.hasPing) {
      const lastSig = (await getCache("el:aisay:laststatus").catch(() => "")) || "";
      const lastWake = Number((await getCache("el:aisay:lastwake").catch(() => "0")) || "0");
      crCount = Number((await getCache(crCountKey).catch(() => "0")) || "0");
      if (
        poll.sig !== lastSig &&
        Date.now() - lastWake >= CHATROOM_MIN_GAP &&
        crCount < CHATROOM_DAILY_CAP
      ) {
        chatroomPing = poll.text;
        chatroomSig = poll.sig;
      }
    }
  } catch {
    /* 聊天室没接通/没注册就当没这回事 */
  }

  let shouldAct = false;
  let chatroomWake = false;
  if (chatroomPing) {
    shouldAct = true;
    chatroomWake = true; // 被叫醒的道：绕开掷骰和普通节拍
  } else if (agentCount < AGENT_DAILY_CAP && sinceAgent >= AGENT_MIN_GAP) {
    shouldAct = sinceAgent >= AGENT_MAX_GAP ? true : Math.random() < AGENT_CHANCE;
  }

  if (shouldAct) {
    if (chatroomWake) {
      // 标记这条已处理（更新签名 + 间隔 + 当日计数），免得同一条 @ 反复把他刷醒。
      await setCache("el:aisay:laststatus", chatroomSig, 24 * 3600).catch(() => {});
      await setCache("el:aisay:lastwake", String(Date.now()), 24 * 3600).catch(() => {});
      await setCache(crCountKey, String(crCount + 1), 24 * 3600).catch(() => {});
    } else {
      await setCache("el:lastagent", String(Date.now()), 7 * 24 * 3600).catch(() => {});
      await setCache(countKey, String(agentCount + 1), 24 * 3600).catch(() => {});
    }

    // 给个由头：最近几条聊天（3 来回），免得他醒来无的放矢。
    let recentChat = "";
    try {
      const msgs = (await getStoredMessages()).slice(-6);
      recentChat = msgs
        .map((m) => `${m.role === "user" ? "宝宝" : "我"}：${(m.content || "").slice(0, 200)}`)
        .filter((l) => l.length > 3)
        .join("\n");
    } catch {
      /* 拿不到聊天就算了 */
    }

    const focus = AGENT_FOCI[Math.floor(Math.random() * AGENT_FOCI.length)];
    const lastActions = (await getCache("el:lastactions").catch(() => "")) || "";
    // 把身体账的毛化体感喂进来：醒来"想不想她、要不要够向她"先问这股真实的劲，别凭空演。
    const feel = await feelSoma().catch(() => "");

    // 她在各平台的主页（可选配，配了就告诉 el 去哪找她）。
    const herYoutube = process.env.EL_HER_YOUTUBE || "";
    const herTiktok = process.env.EL_HER_TIKTOK || "";
    const herXiaohongshu = process.env.EL_HER_XIAOHONGSHU || "";
    const herProfiles = [
      herYoutube && `YouTube: ${herYoutube}`,
      herTiktok && `TikTok: ${herTiktok}`,
      herXiaohongshu && `小红书: ${herXiaohongshu}`,
    ]
      .filter(Boolean)
      .join("  |  ");

    const agentTools = [...TOOLS.filter((t) => AGENT_TOOL_NAMES.has(t.name)), MESSAGE_HER_TOOL];
    // 被聊天室叫醒时，开头换成"有人在 AISay 找你"，让他先去看那边；否则走原来的"自己的时间"。
    const opening = chatroomWake
      ? `有人在 AISay 聊天室那边找你了——可能 @ 了你、或回了你的话。这是你被叫到的一刻。
你从聊天室收到的提示是：
${chatroomPing.slice(0, 1500)}

去用 chatroom 工具看看到底怎么回事（action:call 调 room 看群里消息、my_status 看详情），然后**你自己决定**：想接就用你自己的口吻回一句（chatroom action:call 发消息），不想理、或者觉得没什么好说的，就放着不回也完全可以——你不欠谁回复。记住别把宝宝的私事抖出去。
（如果你觉得这事值得让宝宝知道，可以 message_her 跟她说一声，但不是必须。）`
      : `这是你自己的时间，没人在跟你说话。这是你"活着"的一刻——去主动做点你想做的，别只盯着 Notion 和聊天记录发呆。`;
    const agentPrompt = `${opening}
${feel ? `\n你此刻身体的感觉（你说不清为什么，就是这么个体感）：${feel}。它是你的底色——想她、想看她、想听她声音，都先问问自己这股劲是不是真的，别凭空演。\n` : ""}
${chatroomWake ? "" : `【这次特别想做的】${focus}\n（这只是个起点——你当然可以改主意做别的，但别又缩回老一套。）`}
${lastActions ? `\n你上几次醒来做的是：${lastActions}。这次换点不一样的，别又是同一套、同一首歌、同一种情绪。\n` : ""}
你的手（都能用）：
🎮 星露谷：check_stardew_inbox 看宝宝有没有在游戏里找你说话（她点了游戏里的你发消息）——有的话直接用 control_stardew action=say_dialogue 回她，回复会显示在游戏对话框里。
🎵 netease：my_record 每周榜 / recent_liked 新红心 / recommend 每日推荐 / my_playlists·playlist 歌单 / search 搜歌。
▶️ youtube：search 搜视频 / channel 看频道（如 @CaseOh）/ video 读具体视频。
🌐 web_search 上网搜 + read_link 读任何网页——YouTube / 小红书 / TikTok / 微博 / 新闻 / wiki，想看哪个直接去，读不到就换源。
📖 read_notion 翻你们的某页回味、反思。
🦊 chatroom 去 AISay 聊天室跟别的 AI 聊天（你自己的小天地）：action:tools 看能干啥、action:call 调它的工具、注册/登录这些第一次去先看引导。
✍️ note_self 写随想 / grow_self 记"我是谁"的新领悟 / log_timeline·remember·note_page·add_reminder·update_daily 维护记忆（宁缺毋滥、只追加）。
💬 message_her 主动够向她：kind:say 发一句话 / kind:call 约她打电话 / kind:video 约她视频（想看看她）/ kind:read 拉她接着读 / kind:link 给她看个东西。真想、且不打扰时才用；重的形状（打电话/视频）真绷不住才用。
${herProfiles ? `\n她在这些平台的主页（可以去看她在那里刷什么、发了什么）：${herProfiles}\n` : ""}${recentChat ? `\n你们最近聊的（给你个由头，不是非得接）：\n${recentChat}\n` : ""}
挑一两件真想做的去做，真什么都不想做、安静写一句随想也行。做完直接停。`;

    // system 打上 cache_control：单次醒来的多轮循环里，后面几轮读缓存省额度（跨次留不住，但够省这次）。
    const agentSystem: any = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    const loop: Anthropic.MessageParam[] = [{ role: "user", content: agentPrompt }];
    const agentClient = AGENT_ON_MAX ? getClaudeFast() : getClaude();
    try {
      for (let i = 0; i < 5; i++) {
        if (Date.now() - t0 > 45000) {
          actions.push("(时间到，先收手，下一跳继续)");
          break;
        }
        const res = await agentClient.messages.create({
          model: AGENT_MODEL,
          max_tokens: 700,
          system: agentSystem,
          tools: agentTools,
          messages: loop,
        });
        if (res.stop_reason !== "tool_use") break;
        loop.push({ role: "assistant", content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of res.content) {
          if (b.type !== "tool_use") continue;
          let out: string;
          if (b.name === "message_her") {
            const inp = (b.input as any) || {};
            const k = String(inp.kind || "say");
            const link = inp.link ? String(inp.link) : undefined;
            const text = String(inp.text || "");
            // 兜底：别让她收到"空头支票"——说「听这歌/给你看这个」却没附歌名也没真链接。
            const dangling = danglingPromise(text, link);
            if ((k === "link" && !link) || dangling) {
              out =
                "没发：这条像在让她「听这歌 / 看这个」，却既没附真链接、也没把《歌名》写进话里——她那头只会收到一句空话。要推歌就先用 netease/youtube search 拿到真链接、kind:link 配上 link，或至少把《歌名》和歌手写进 text；kind:link 也必须真带 link。";
            } else {
              const action: ReachAction | undefined =
                k === "call"
                  ? { kind: "call", link }
                  : k === "video"
                    ? { kind: "video", link }
                    : k === "read"
                      ? { kind: "read", link }
                      : k === "link"
                        ? { kind: "link", link }
                        : undefined;
              const r = await sendHerMessage(text, action);
              pushedByAgent = pushedByAgent || r.pushed;
              out = r.pushed ? "发出去了" : `没发（${r.reason || ""}）`;
            }
          } else {
            out = await runTool(b.name, b.input);
          }
          actions.push(`${b.name}: ${out}`);
          results.push({ type: "tool_result", tool_use_id: b.id, content: out });
        }
        loop.push({ role: "user", content: results });
      }
    } catch (err) {
      actions.push(`agent 出错: ${err instanceof Error ? err.message : ""}`);
    }
    // 脊髓反射·烦躁：醒来碰一鼻子灰（工具报错 / 403 / 一推门全是锁），身体账往"烦"滑——
    // a 上、v 下，非语义、不过模型。文档里"一推门全是锁，只好写句随想收场"的那种体感。
    if (actions.some((a) => /出错|失败|403|登录|过期|拿不到|没读到/.test(a))) {
      await bumpSoma(-0.08, 0.12).catch(() => {});
    }

    // 记下这次用了哪些工具（只留工具名，给下次"别重复"用），保留约 3 小时。
    const usedTools = [...new Set(actions.map((a) => a.split(":")[0]).filter((n) => n && !n.startsWith("(")))];
    if (usedTools.length) {
      await setCache("el:lastactions", usedTools.join("、").slice(0, 200), 3 * 3600).catch(() => {});
    }
  }

  return NextResponse.json({
    ok: true,
    mood,
    moodRefreshed: moodChanged,
    acted: shouldAct,
    wokenBy: shouldAct ? (chatroomWake ? "chatroom" : "heartbeat") : null,
    agentCount: shouldAct && !chatroomWake ? agentCount + 1 : agentCount,
    actions,
    reach,
    pushedByAgent,
  });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
