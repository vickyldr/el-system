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

export const runtime = "nodejs";

type ChatTurn = { role: "user" | "assistant"; content: string; image?: string };

// 把一条消息（可能带图）变成 Claude 的 content：纯文本或 图+文 块。
// image 支持 base64 data URL（手机直传）或普通 http(s) url。
function toContent(text: string, image?: string): Anthropic.MessageParam["content"] {
  if (!image) return text;
  const data = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
  const imgBlock: Anthropic.ContentBlockParam = data
    ? {
        type: "image",
        source: { type: "base64", media_type: data[1] as any, data: data[2] },
      }
    : { type: "image", source: { type: "url", url: image } };
  const blocks: Anthropic.ContentBlockParam[] = [imgBlock];
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

export async function POST(req: Request) {
  let body: { message?: string; image?: string; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const image = typeof body.image === "string" && body.image ? body.image : undefined;
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
  const messages: Anthropic.MessageParam[] = [
    ...prior.slice(-100).map((t: any) => ({ role: t.role, content: toContent(t.content, t.image) })),
    { role: "user", content: toContent(message, image) },
  ];

  try {
    const claude = getClaude();
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    const loop: Anthropic.MessageParam[] = [...messages];
    let reply = "";

    // 工具循环：El 需要时读链接 / 读 Notion / 写记忆，最多几轮。
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
            const out = await runTool(b.name, b.input);
            results.push({ type: "tool_result", tool_use_id: b.id, content: out });
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

    // 云端存档：图片单独存、历史里放引用 URL，这样刷新/换设备也能看到。
    if (cloud) {
      let storedImage: string | undefined;
      if (image) {
        const id = await putImage(image);
        if (id) storedImage = `/api/img/${id}`;
      }
      const ts = Date.now();
      await appendMessages([
        { role: "user", content: message, image: storedImage, ts },
        { role: "assistant", content: reply, ts: ts + 1 },
      ]);
    }

    return NextResponse.json({ reply, cloud });
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
