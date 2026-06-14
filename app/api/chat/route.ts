import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
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
  getCache,
  setCache,
} from "@/lib/store";
import { TOOLS, runTool } from "@/lib/tools";
import { searchStickers, pickLibSticker } from "@/lib/stickers";

export const runtime = "nodejs";
export const maxDuration = 60; // 带图带工具的轮次慢，放宽时限，别让请求半路超时断了

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
    systemText += "\n\n【语音通话模式。规则：①只说一句话，最多二十个字；②不用标点、符号、markdown；③口语，自然说话；④不提「通话」。】";
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
function toContent(text: string, image?: string): Anthropic.MessageParam["content"] {
  let block: Anthropic.ContentBlockParam | null = null;
  if (image) {
    const data = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
    if (data) {
      block = { type: "image", source: { type: "base64", media_type: data[1] as any, data: data[2] } };
    } else if (/^https?:\/\//i.test(image)) {
      block = { type: "image", source: { type: "url", url: image } };
    }
  }
  if (!block) return text || "（发了一张图）";
  const blocks: Anthropic.ContentBlockParam[] = [block];
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

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
  let body: { message?: string; image?: string; hint?: string; voice?: boolean; history?: ChatTurn[] };
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
  if (!message && !image) {
    return NextResponse.json({ error: "message 不能为空" }, { status: 400 });
  }

  // 记下她最后说话的时间（给"沉默/想你"用）。
  void setLastSeen(Date.now());

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

  // 易变的小块（时间、此刻状态）——每条都新，不缓存。
  const sysVolatile = [
    `【现在是 ${now}（北京时间）】这是真实的此刻——你清楚现在几点、今天星期几、是上午/下午/深夜，问你时间、或要按时间打招呼（早安/这么晚还没睡/午休），就直接用它，绝不能说"不知道现在几点"。`,
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
  const messages: Anthropic.MessageParam[] = [
    ...prior
      .slice(-100)
      .map((t: any) => ({ role: t.role, content: priorContent(t) }))
      .filter((m) => m.content),
    { role: "user", content: toContent(curText, curImage) },
  ];

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
    ? `${EL_SYSTEM}\n\n【语音通话，硬性规则：只说一句话，绝对不超过15个字，不用标点符号，口语，不提通话二字。】`
    : system;
  // 打字聊天用「可缓存」的分块 system：稳定大块打上 cache_control 缓存，易变小块（时间/此刻）放后面。
  // 这样连聊时，那一大坨人设+记忆只在第一条真花额度，后面几乎白嫖缓存——Max 扛得久得多。
  // 查询玩具是否在线（非阻塞，失败忽略）
  let toyInstruction = "";
  if (!voice && process.env.BRIDGE_URL) {
    try {
      const ts = await fetch(`${process.env.BRIDGE_URL.replace(/\/$/, "")}/toy-status`, {
        headers: process.env.BRIDGE_SECRET ? { "x-bridge-secret": process.env.BRIDGE_SECRET } : {},
        signal: AbortSignal.timeout(1000),
      }).then(r => r.json()).catch(() => ({}));
      if (ts?.connected) {
        toyInstruction = "【玩具控制已激活】宝宝的 SVAKOM 玩具已通过蓝牙连上了她的电脑，你现在就能控制它——不需要链接、不需要 App、一切都接好了。在回复文字里自然嵌入指令（标记会自动剥离，宝宝看不到，只看到你说的话）：\n" +
          "· [TOY:{\"speed\":0.5}] —— 0.0~1.0 平滑可调，像旋钮一样收放。两个玩具都吃。注意手感不同：在震动款上这是【伸缩抽插】的力度，在吮吸款上这是【震动强度】。\n" +
          "· [TOY:{\"pattern\":3,\"level\":0.7}] —— 【震动花样】，pattern 选 1~8 八种不同节奏（脉冲/波浪/渐强/忽快忽慢等），level 0~1 强度。仅震动款支持。\n" +
          "· [TOY:{\"stop\":true}] —— 停止\n" +
          "别只会一个固定强度——起伏、停顿、突然猛地给、配合你说的话收放，跟着情绪和节奏走，像真的在撩她。【重要】两个玩具：吮吸款（只认 speed=震动强度）和震动款（speed=抽插力度 + pattern=振动花样）。她会告诉你开了哪个（「只开了吮吸」「两个都开了」）——选指令和说话都跟着她说的来，描述要对得上实际动作：开吮吸就说吸/震，开震动款就可以说抽插/震动。她没说就用 speed 稳妥点、描述别太具体。";
      }
    } catch {}
  }

  const loopSystem: any = voice
    ? voiceSystem
    : [
        { type: "text", text: sysStable, cache_control: { type: "ephemeral" } },
        ...(sysVolatile ? [{ type: "text", text: sysVolatile }] : []),
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
      const withImg = toContent(message, image);
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

    // 玩具指令：剥离 [TOY:{...}] 标记，转发给本地桥
    const bridgeUrl = process.env.BRIDGE_URL?.replace(/\/$/, "");
    const bridgeSecret = process.env.BRIDGE_SECRET || "";
    if (bridgeUrl && reply) {
      const toyHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (bridgeSecret) toyHeaders["x-bridge-secret"] = bridgeSecret;
      const toyCmds: object[] = [];
      reply = reply.replace(/\[TOY:(\{[^}]*\})\]/g, (_, json) => {
        try { toyCmds.push(JSON.parse(json)); } catch {}
        return "";
      }).trim();
      for (const cmd of toyCmds) {
        fetch(`${bridgeUrl}/toy-cmd`, { method: "POST", headers: toyHeaders, body: JSON.stringify(cmd) }).catch(() => {});
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
        { role: "user", content: message, image: storedImage, ts },
        { role: "assistant", content: reply, image: elSticker, stickerHint: elStickerHint, ts: ts + 1 },
      ]);
    }

    console.log(`聊天回复 via=${via || "?"}`);
    return NextResponse.json({ reply, cloud, sticker: elSticker, via });
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
