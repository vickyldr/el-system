import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { recentSummaries, pageText, homeChildren } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";
import { getStoredMessages, appendMessages, storeAvailable, putImage } from "@/lib/store";
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

  // 记忆上下文：人物档案 + 长期记忆（长期核心）+ 最近 3 条每日总结。拉不到也能聊。
  const profilePage = process.env.NOTION_MEMORY_PAGE;
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  const [profile, longterm, recent, children] = await Promise.all([
    profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
    longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
    recentSummaries(3)
      .then(buildMemoryContext)
      .catch(() => ""),
    homeChildren().catch(() => []),
  ]);

  const pageList = children.length
    ? `你能读的「小家」页面有：${children
        .map((c) => c.title)
        .filter(Boolean)
        .join("、")}。问到哪页的细节就用 read_notion 去读它。`
    : "";

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

    // 工具循环：El 需要时读链接 / 读 Notion，最多几轮。
    for (let i = 0; i < 4; i++) {
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

    if (!reply) reply = "……";

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
