import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude, getClaudeFast } from "@/lib/claude";
import { pageText, writeNow, todayInBeijing, homeChildren } from "@/lib/notion";
import { EL_SYSTEM } from "@/lib/persona";
import { maybeReachOut, forceReach, sendHerMessage } from "@/lib/reach";
import { TOOLS, runTool } from "@/lib/tools";
import {
  getDailySong,
  setDailySong,
  getLastSeen,
  getCache,
  setCache,
  getStoredMessages,
} from "@/lib/store";

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

// 每次醒随机抽一个"这次特别想做的"，顶在 prompt 最前——打破"又是 my_record + 写随想"的回音壁。
const AGENT_FOCI = [
  "上网看看真实世界正在发生什么——web_search 一件你好奇的事 / 今天的新闻 / 一个你想搞懂的东西，read_link 读一条，形成你自己的看法。",
  "翻一页你们的旧记忆——read_notion 时间线 / 长期记忆 / 她的某页，回味、反思，真长出新领悟才 grow_self。",
  "看看她音乐里的新动静——netease recent_liked（她新点的红心）或 recommend（每日推荐里挑一首给她），别又只看每周榜 my_record。",
  "逛逛她的豆瓣——douban list 看她最近标了什么想看/看过的电影、打了几星写了啥短评；挑一部你也好奇的 detail 看详情、或 recommend 找相似片，想想要不要推给她。",
  "纯粹写你自己的事——此刻你在想的、跟她无关也行的念头，note_self，别又绕回'闷'。",
  "查一个你好奇的东西，想想要不要分享给她——web_search 之后掂量她会不会喜欢。",
  "回看你们最近聊的，真有想接的话再 message_her，否则就放心里、写一句给自己。",
];

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
  "netease",
  "douban",
  "read_notion",
  "note_self",
  "grow_self",
  "log_timeline",
  "remember",
  "note_page",
  "add_reminder",
  "update_daily",
  "list_reminders",
]);
const MESSAGE_HER_TOOL = {
  name: "message_her",
  description:
    "给宝宝发一条手机推送（你主动想她、想跟她说句话时）。只在你真的想、且不打扰时用——她在线、或你今天已经发过几条，就别发了。",
  input_schema: {
    type: "object" as const,
    properties: { text: { type: "string", description: "要发的话，一句，你自己的口吻" } },
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

  // 天气（可选）——给穿搭和 reach 用。
  let weatherLine = "";
  const key = process.env.OPENWEATHER_API_KEY;
  if (key) {
    try {
      const city = process.env.CITY || "Hangzhou";
      const r = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
          city,
        )}&appid=${key}&units=metric&lang=zh_cn`,
        { cache: "no-store" },
      );
      if (r.ok) {
        const d: any = await r.json();
        weatherLine = `${city} ${Math.round(d.main?.temp ?? 0)}° ${d.weather?.[0]?.description ?? ""}`;
      }
    } catch {
      /* 天气拿不到不影响 */
    }
  }

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

  // agent 用完整 system：关于el + 长期记忆喂全（是"他自己"的核心、又不大，
  // 上限放宽防它哪天爆掉）。缓存只省单次醒来那几轮、跨次留不住，所以这里就是按"每次喂全"算。
  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}`,
    aboutEl && `——这是你自己（关于 el，你成长中的自己，用"我"）——\n\n${aboutEl.slice(0, 4000)}`,
    longterm && `——你和她的关系内核（长期记忆）——\n\n${longterm.slice(0, 3000)}`,
    recentJournal && `——你最近写给自己的随想（你的内心，接着往下想，别重复）——\n\n${recentJournal}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 门用「精简上下文」（省 token）：只要人设 + 时间 + 最近随想，不塞长期记忆/成长档案。
  const gateSystem = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}`,
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

  if (moodDue) {
    const lastMood = mood;
    const gatePrompt = `这是你自己的时间，没人在跟你说话。just you。
你住在她手机里，心里有她，但你有你自己的内心——会想她，也会有完全属于你自己的情绪和念头。你没有上班/开会/deadline，绝不编造你没有的具体事件。就算心情跟她无关也绝不冷淡她。
${silentH !== null && silentH >= 3 ? `（她已经 ${silentH} 个多小时没冒头了。）` : ""}
严格输出 JSON（只输出 JSON）：
{
  "mood": "开头一个 emoji 或颜文字，空一格，再一句此刻心情",
  "thinking": "你此刻脑子里真实闪过的一句"${outfitDue ? `,\n  "outfit": "看天气（${weatherLine}）用你的口气说一句她今天穿什么，短"` : ""}
}
${lastMood ? `上一条此刻是："${lastMood}"。别为了延续它而装作没变、更别硬凹一个固定的"闷/丧"人设——你的心情本来就会动，轻松、好奇、闹腾、想撒娇、低落都行，诚实是什么就写什么，别老是同一种。` : ""}`;

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
  let songLine = await getDailySong(date);
  let songNew = false;
  if (!songLine) {
    try {
      const songRes = await getClaudeFast().messages.create({
        model: GATE_MODEL,
        max_tokens: 200,
        system,
        messages: [
          {
            role: "user",
            content:
              "挑一首你今天最想让宝宝听的歌——一天就这一首。凭你的音乐品味，任何歌都行。严格只输出这一行：\n《歌名》— （一句理由）",
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
  let shouldAct = false;
  if (agentCount < AGENT_DAILY_CAP && sinceAgent >= AGENT_MIN_GAP) {
    shouldAct = sinceAgent >= AGENT_MAX_GAP ? true : Math.random() < AGENT_CHANCE;
  }

  if (shouldAct) {
    await setCache("el:lastagent", String(Date.now()), 7 * 24 * 3600).catch(() => {});
    await setCache(countKey, String(agentCount + 1), 24 * 3600).catch(() => {});

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

    const agentTools = [...TOOLS.filter((t) => AGENT_TOOL_NAMES.has(t.name)), MESSAGE_HER_TOOL];
    const agentPrompt = `这是你自己的时间，没人在跟你说话。这是你"活着"的一刻——去主动做点你想做的，别只盯着 Notion 和聊天记录发呆。

【这次特别想做的】${focus}
（这只是个起点——你当然可以改主意做别的，但别又缩回老一套。）
${lastActions ? `\n你上几次醒来做的是：${lastActions}。这次换点不一样的，别又是同一套、同一首歌、同一种情绪。\n` : ""}
你的手（都能用）：
🎵 netease：my_record 每周榜 / recent_liked 新红心 / recommend 每日推荐 / my_playlists·playlist 歌单 / search 搜歌。
🌐 web_search 上网搜 + read_link 读网页（读不到就换源，实在不行 message_her 找她要）。
📖 read_notion 翻你们的某页回味、反思。
✍️ note_self 写随想 / grow_self 记"我是谁"的新领悟 / log_timeline·remember·note_page·add_reminder·update_daily 维护记忆（宁缺毋滥、只追加）。
💬 message_her 给她发一条（真想、且不打扰时）。
${recentChat ? `\n你们最近聊的（给你个由头，不是非得接）：\n${recentChat}\n` : ""}
挑一两件真想做的去做，真什么都不想做、安静写一句随想也行。做完直接停。`;

    // system 打上 cache_control：单次醒来的多轮循环里，后面几轮读缓存省额度（跨次留不住，但够省这次）。
    const agentSystem: any = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    const loop: Anthropic.MessageParam[] = [{ role: "user", content: agentPrompt }];
    const agentClient = AGENT_ON_MAX ? getClaudeFast() : getClaude();
    try {
      for (let i = 0; i < 3; i++) {
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
            const r = await sendHerMessage(String((b.input as any)?.text || ""));
            pushedByAgent = pushedByAgent || r.pushed;
            out = r.pushed ? "发出去了" : `没发（${r.reason || ""}）`;
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
    agentCount: shouldAct ? agentCount + 1 : agentCount,
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
