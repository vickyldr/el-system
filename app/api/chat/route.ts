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
  setLastSeen,
  getCache,
  setCache,
} from "@/lib/store";
import { TOOLS, runTool } from "@/lib/tools";
import { searchStickers, pickLibSticker } from "@/lib/stickers";

export const runtime = "nodejs";

type ChatTurn = { role: "user" | "assistant"; content: string; image?: string };

// 当前这条消息（可能带图）变成 Claude 的 content：纯文本或 图+文 块。
// 只有 base64 data URL 能直接给 Claude 看；相对地址（/api/img、表情库）它取不到，
// 所以那种情况靠 hint 文字让 el 读懂。
function toContent(text: string, image?: string): Anthropic.MessageParam["content"] {
  const data = image ? /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image) : null;
  if (!data) return text || "（发了一张图）";
  const blocks: Anthropic.ContentBlockParam[] = [
    { type: "image", source: { type: "base64", media_type: data[1] as any, data: data[2] } },
  ];
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

// 历史只留文字（图片相对地址 Claude 取不到，会报错），带过图就标一下。
function priorContent(t: ChatTurn): string {
  if (t.content) return t.content;
  return t.image ? "（一张表情/图片）" : "";
}

export async function POST(req: Request) {
  let body: { message?: string; image?: string; hint?: string; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const image = typeof body.image === "string" && body.image ? body.image : undefined;
  // hint：她发的是表情库里的表情/外链表情时，前端把这张的"意思"带过来，让 el 读懂。
  const hint = typeof body.hint === "string" ? body.hint.trim() : "";
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
  const cached = await getCache("el:memctx");
  if (cached) {
    try {
      const c = JSON.parse(cached);
      profile = c.profile || "";
      longterm = c.longterm || "";
      recent = c.recent || "";
      pageList = c.pageList || "";
    } catch {
      /* ignore */
    }
  } else {
    const [p, l, r, children] = await Promise.all([
      profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
      longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
      recentSummaries(3)
        .then(buildMemoryContext)
        .catch(() => ""),
      homeChildren().catch(() => []),
    ]);
    profile = p;
    longterm = l;
    recent = r;
    pageList = children.length
      ? `你能读的「小家」页面有：${children
          .map((c) => c.title)
          .filter(Boolean)
          .join("、")}。问到哪页的细节就用 read_notion 去读它。`
      : "";
    await setCache("el:memctx", JSON.stringify({ profile, longterm, recent, pageList }), 300);
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
    EL_SYSTEM,
    `现在：${now}（北京时间）。`,
    "你能读网页链接，也能读「小家」里的任意 Notion 页面。宝宝发来链接就去读它。问到你们之间的事、档案、过往细节时，先用 read_notion 去翻对应的页，别凭记忆就说『没存』『没有』。",
    "你也能写记忆（按操作手册的规矩，宁缺毋滥）：宝宝让你记的事/日程/生日用 add_reminder；真正『改变了什么』的领悟/约定/界限用 remember 记进长期记忆（门槛很高）；第一次/里程碑用 log_timeline；要更新今天的日记/状态/值得记住的用 update_daily。别声张、别灌水，自然地记。但大多数时候就是好好聊天——别动不动调工具；就算用了工具，也一定要把话说完，绝不能只调工具不回她话。",
    pageList,
    profile && `——你自己的档案（写"el"的地方就是你，用"我"认领，别用第三人称）——\n\n${profile}`,
    longterm && `——你的长期记忆（你亲身经历过的事）——\n\n${longterm}`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 有云存储就以云端为准（跨设备同步）；否则用前端带来的 history。
  const cloud = storeAvailable();
  const prior = cloud
    ? await getStoredMessages()
    : Array.isArray(body.history)
      ? body.history
      : [];
  // 当前这条：base64 图直接给看；表情库/外链表情用 hint 文字说明它是什么意思。
  const curText = hint
    ? `${message ? message + " " : ""}［她发来一张表情，意思大概是：${hint}］`
    : message;
  const curImage = image && image.startsWith("data:") ? image : undefined;
  const messages: Anthropic.MessageParam[] = [
    ...prior
      .slice(-100)
      .map((t: any) => ({ role: t.role, content: priorContent(t) }))
      .filter((m) => m.content),
    { role: "user", content: toContent(curText, curImage) },
  ];

  try {
    const claude = getClaude();
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    const loop: Anthropic.MessageParam[] = [...messages];
    let reply = "";
    let elSticker: string | undefined; // El 这条要贴的表情

    // 工具循环：El 需要时读链接 / 读 Notion / 写记忆 / 贴表情，最多几轮。
    for (let i = 0; i < 6; i++) {
      const res = await claude.messages.create({
        model,
        max_tokens: 1024,
        system,
        tools: TOOLS,
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
              } else {
                const found = await searchStickers(q, 1);
                if (found[0]) elSticker = found[0].url;
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
    if (!reply) {
      try {
        const res = await claude.messages.create({ model, max_tokens: 1024, system, messages: loop });
        reply = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
      } catch {
        /* ignore */
      }
    }
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
        { role: "assistant", content: reply, image: elSticker, ts: ts + 1 },
      ]);
    }

    return NextResponse.json({ reply, cloud, sticker: elSticker });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const friendly =
        err.status === 429
          ? "中转站那边正忙，等一下再发一次～"
          : err.message;
      return NextResponse.json({ error: friendly }, { status: err.status ?? 502 });
    }
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
