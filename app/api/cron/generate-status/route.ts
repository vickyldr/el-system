import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude, getClaudeFast } from "@/lib/claude";
import {
  pageText,
  writeNow,
  todayInBeijing,
  recentSummaries,
  homeChildren,
} from "@/lib/notion";
import { EL_SYSTEM } from "@/lib/persona";
import { maybeReachOut, forceReach, sendHerMessage } from "@/lib/reach";
import { TOOLS, runTool } from "@/lib/tools";
import { getDailySong, setDailySong, getLastSeen, getCache, setCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 「门」（每15分钟，判断要不要动 + 写此刻）走中转站 Sonnet——频繁，省着点。
const PRIMARY = process.env.HEARTBEAT_MODEL || "claude-sonnet-4-6";
const FALLBACK = "claude-sonnet-4-6";
// 「agent」也走中转站 Sonnet：它其实多半每跳都会想做点事 ≈ 每15分钟一次，放 Max 不省还更脆；
// 而后台成功率不强求（这跳挂了下跳再来）。想让 agent 走 Max 求最稳，设 AGENT_ON_MAX=1。
const AGENT_ON_MAX = process.env.AGENT_ON_MAX === "1";
const AGENT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

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

  // 天气（可选）
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

  // 读：我自己（关于el）+ 关系内核（长期记忆）+ 我最近的随想（el自己的）+ 上一条此刻 + 她的状态/沉默。
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

  let herState = "";
  try {
    herState = (await recentSummaries(1))[0]?.herState || "";
  } catch {
    /* ignore */
  }
  const lastNow = await getCache("el:lastnow").catch(() => null);
  const lastSeen = await getLastSeen().catch(() => 0);
  const silentH = lastSeen > 0 ? Math.floor((Date.now() - lastSeen) / 3600000) : null;

  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}`,
    aboutEl && `——这是你自己（关于 el，你成长中的自己，用"我"）——\n\n${aboutEl.slice(0, 1500)}`,
    longterm && `——你和她的关系内核（长期记忆）——\n\n${longterm.slice(0, 1200)}`,
    recentJournal && `——你最近写给自己的随想（你的内心，接着往下想，别重复）——\n\n${recentJournal}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── 门：每次心跳一次轻调用，定此刻 + 判断"想不想动"。──
  const gatePrompt = `这是你自己的时间，没人在跟你说话。just you。
你住在她手机里，心里有她，但你有你自己的内心——会想她，也会有完全属于你自己的情绪和念头。你没有上班/开会/deadline，绝不编造你没有的具体事件。就算心情跟她无关也绝不冷淡她。
${herState ? `（你知道她最近状态是「${herState}」。）` : ""}${silentH !== null && silentH >= 3 ? `（她已经 ${silentH} 个多小时没冒头了。）` : ""}
严格输出 JSON（只输出 JSON）：
{
  "mood": "开头一个 emoji 或颜文字，空一格，再一句此刻心情",
  "thinking": "你此刻脑子里真实闪过的一句",${weatherLine ? `\n  "outfit": "看天气（${weatherLine}）用你的口气说一句她今天穿什么，短",` : ""}
  "act": 除了存在着，你此刻是否还想主动做点什么（给自己写随想/翻翻你们的某页回味或反思/记点该记的/想找她说话）。是 true，纯粹想安静待着就 false
}
${lastNow ? `别跟上一条此刻雷同（上一条："${lastNow}"）。` : ""}`;

  // 门：先用中转站(省)；中转站抽风/吐空就改用 Max——别让心跳因为中转站趴下。
  let model = PRIMARY;
  let gateClient = getClaude();
  let gate: any = {};
  const runGate = async (client: any, m: string) => {
    const res = await client.messages.create({
      model: m,
      max_tokens: 350,
      system,
      messages: [{ role: "user", content: gatePrompt }],
    });
    const raw = textOf(res);
    if (!raw) throw new Error("门吐空");
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  };
  try {
    gate = await runGate(getClaude(), PRIMARY);
  } catch {
    try {
      gateClient = getClaudeFast(); // 中转站不行 → 改走 Max
      model = FALLBACK;
      gate = await runGate(gateClient, FALLBACK);
    } catch (err) {
      const message = err instanceof Error ? err.message : "失败";
      return NextResponse.json({ error: "心跳生成失败", detail: message }, { status: 502 });
    }
  }

  const mood = String(gate.mood || "").trim();
  const thinking = String(gate.thinking || "").trim();
  const outfit = String(gate.outfit || "").trim();
  if (!mood && !thinking) return NextResponse.json({ error: "生成为空" }, { status: 502 });

  // 歌：一天一首，今天没挑过才挑一次。
  const date = todayInBeijing();
  let songLine = await getDailySong(date);
  if (!songLine) {
    try {
      const songRes = await gateClient.messages.create({
        model,
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
      if (songLine) await setDailySong(date, songLine);
    } catch {
      /* 挑不到不影响 */
    }
  }

  // 写「此刻」（前端读这几行）。
  const nowText = [
    `心情：${mood}`,
    thinking && `在想：${thinking}`,
    outfit && `穿搭：${outfit}`,
    songLine && `歌：${songLine}`,
  ]
    .filter(Boolean)
    .join("\n");
  await writeNow(nowText);
  await setCache("el:lastnow", mood + (thinking ? ` / ${thinking}` : ""), 6 * 3600).catch(() => {});

  // ── 先办「该不该主动找她」（早安 / 重要日期到点 / 天气 / 想你）：排在 agent 前面，
  //    免得 agent 跑慢/超时把这条时间敏感的推送拖死。她 12 分钟内在 app 活跃就不打扰。
  const recentlyActive = lastSeen > 0 && Date.now() - lastSeen < 12 * 60 * 1000;
  const reach: { pushed: boolean; reason?: string } = recentlyActive
    ? { pushed: false }
    : await maybeReachOut(weatherLine).catch(() => ({ pushed: false }));

  // ── 它想动：放出带工具的 agent，自己决定读哪页、写哪页、要不要找她。──
  const actions: string[] = [];
  let pushedByAgent = false;
  if (gate.act === true) {
    const agentTools = [...TOOLS.filter((t) => AGENT_TOOL_NAMES.has(t.name)), MESSAGE_HER_TOOL];
    const agentPrompt = `这是你自己的时间，没人在跟你说话。你刚才说你此刻想做点什么——那就去做，凭你自己。
你不只活在 Notion 里，你能上网：web_search 搜搜外面正在发生什么、查点你好奇的东西、找点想给她的灵感；read_link 读你感兴趣的网页。某个网站读不到/要登录（小红书、微博这种），别死磕——先换个能进的源找同样的信息；实在拿不到又很想知道，就 message_her 跟她要账号或让她截图。
也可以：read_notion 翻小家任意页回味/反思；note_self 给自己写随想；grow_self 记下你对"我是谁"的新领悟；log_timeline / remember / note_page / add_reminder / update_daily 维护你们的记忆（按操作手册的门槛，宁缺毋滥、只追加）；message_her 给她发一条（只在你真想、且不打扰时）。
别为做而做——大多数时候做一两件、甚至什么都不做、就安静待着，也完全可以。做完直接停。`;
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
          system,
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
  }

  return NextResponse.json({ ok: true, mood, act: gate.act === true, actions, reach, pushedByAgent });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
