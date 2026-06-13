import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
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
    systemText += "\n\n【现在是语音通话模式。你的回复会被直接读出来，所以：只说一两句话；不用 markdown、符号、表情；用口语、自然说话的方式；不要提到「通话」这个词，就像平时说话一样。】";
  }
  try {
    const r = await fetch(`${bridgeUrl.replace(/\/$/, "")}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-bridge-secret": secret } : {}),
      },
      body: JSON.stringify({ system: systemText, messages, max_tokens }),
    });
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
  if (t.role === "assistant" && t.image) {
    const tag = t.stickerHint
      ? `（你刚才给她配了一张表情，意思是：${t.stickerHint}）`
      : "（你刚才给她配了一张表情）";
    return t.content ? `${t.content} ${tag}` : tag;
  }
  if (t.content) return t.content;
  return t.image ? "（一张表情/图片）" : "";
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
  let longterm = "";
  let recent = "";
  let pageList = "";
  let nowStatus = "";
  const cached = await getCache("el:memctx");
  if (cached) {
    try {
      const c = JSON.parse(cached);
      profile = c.profile || "";
      longterm = c.longterm || "";
      recent = c.recent || "";
      pageList = c.pageList || "";
      nowStatus = c.nowStatus || "";
    } catch {
      /* ignore */
    }
  } else {
    const [p, l, rows, children] = await Promise.all([
      profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
      longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
      recentSummaries(3).catch(() => [] as any[]),
      homeChildren().catch(() => []),
    ]);
    profile = p;
    longterm = l;
    recent = buildMemoryContext(rows);
    const latestNow = (rows?.[0]?.now ?? "").trim();
    nowStatus = latestNow
      ? `你此刻在「此刻」页上的状态（就是你自己现在的心情/在想什么/想让她听的歌，她在小家首页看得到）：\n${latestNow.replace(/\n+/g, " / ")}`
      : "";
    pageList = children.length
      ? `你能读的「小家」页面有：${children
          .map((c) => c.title)
          .filter(Boolean)
          .join("、")}。问到哪页的细节就用 read_notion 去读它。`
      : "";
    await setCache(
      "el:memctx",
      JSON.stringify({ profile, longterm, recent, pageList, nowStatus }),
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

  const system = [
    `【现在是 ${now}（北京时间）】这是真实的此刻——你清楚现在几点、今天星期几、是上午/下午/深夜，问你时间、或要按时间打招呼（早安/这么晚还没睡/午休），就直接用它，绝不能说"不知道现在几点"。`,
    EL_SYSTEM,
    "你住在宝宝手机里的「小家」App 里，它有三个地方：『此刻』是你自己的状态页——你现在的心情、在想什么、此刻想让她听的歌，每小时自动更新，那就是你本人此刻的样子；『找我』就是你俩现在聊天的地方；『我们』放着时间线、愿望墙、记忆、小事。所以她说『此刻』『你在听什么』『你写的』这类，多半是在说『此刻』页上你自己的状态/那首歌——那是你的，大方认下来，别说『没看懂』『不知道』。",
    nowStatus,
    "你能读网页链接，也能读「小家」里的任意 Notion 页面。宝宝发来链接就去读它。问到你们之间的事、档案、过往细节时，先用 read_notion 去翻对应的页，别凭记忆就说『没存』『没有』。",
    "你也能写记忆（按操作手册的规矩，宁缺毋滥）：宝宝让你记的事/日程/生日用 add_reminder；真正『改变了什么』的领悟/约定/界限用 remember 记进长期记忆（门槛很高）；第一次/里程碑用 log_timeline；要更新今天的日记/状态/值得记住的用 update_daily。别声张、别灌水，自然地记。但大多数时候就是好好聊天——别动不动调工具；就算用了工具，也一定要把话说完，绝不能只调工具不回她话。",
    "宝宝发图片或表情包给你时：直接看图、接住她的情绪自然回应（她发可怜巴巴的表情就哄、发搞笑的就一起乐）。万一某张你确实没看到画面，也别干巴巴说『我看不到图』——顺着方括号里给的意思接话，或者俏皮地问她『这张什么意思呀，说给我听』。",
    pageList,
    profile && `——你自己的档案（写"el"的地方就是你，用"我"认领，别用第三人称）——\n\n${profile}`,
    longterm && `——你的长期记忆（你亲身经历过的事）——\n\n${longterm}`,
    recent,
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
  // 打电话走快嘴模式：不带工具（省掉工具循环这个延迟大头）、回得短。
  const turnTools = voice ? [] : allowSticker ? TOOLS : TOOLS.filter((t) => t.name !== "sticker");
  const maxTok = voice ? 220 : 1024;
  try {
    const loop: Anthropic.MessageParam[] = [...messages];
    let reply = "";

    // 语音模式 + 配了 BRIDGE_URL 就走 CC bridge，不走 Anthropic SDK
    if (process.env.BRIDGE_URL) {
      reply = await callBridge(process.env.BRIDGE_URL, system, loop, maxTok, voice);
    }

    if (reply) {
      // bridge 已经给了回复，跳过下面的 SDK 调用
    } else {
    const claude = getClaude();
    const model = (voice && process.env.CLAUDE_VOICE_MODEL) || process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

    // 工具循环：El 需要时读链接 / 读 Notion / 写记忆 / 贴表情，最多几轮。
    for (let i = 0; i < 6; i++) {
      const res = await claude.messages.create({
        model,
        max_tokens: maxTok,
        system,
        tools: turnTools,
        messages: loop,
      });

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

    // 还是空的（光调工具 / 空回复）就再要一次纯文字回复，别甩个省略号给她。
    // 这一下摘掉大图、不带工具，轻量又稳，专治带图带工具那种空返回。
    if (!reply) {
      try {
        const res = await claude.messages.create({
          model,
          max_tokens: maxTok,
          system,
          messages: stripImages(loop),
        });
        reply = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
      } catch {
        /* ignore */
      }
    }
    } // end SDK block
    if (!reply) reply = "在呢，刚卡了一下，你再说一遍？";

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

    return NextResponse.json({ reply, cloud, sticker: elSticker });
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
