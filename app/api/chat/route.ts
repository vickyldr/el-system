import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { recentSummaries, pageText } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";
import { getStoredMessages, appendMessages, storeAvailable } from "@/lib/store";
import { TOOLS, runTool } from "@/lib/tools";

export const runtime = "nodejs";

type ChatTurn = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  let body: { message?: string; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "message 不能为空" }, { status: 400 });
  }

  // 记忆上下文：人物档案 + 长期记忆（长期核心）+ 最近 3 条每日总结。拉不到也能聊。
  const profilePage = process.env.NOTION_MEMORY_PAGE;
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  const [profile, longterm, recent] = await Promise.all([
    profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
    longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
    recentSummaries(3)
      .then(buildMemoryContext)
      .catch(() => ""),
  ]);

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
    "你能读网页链接，也能读你们「小家」里的任意 Notion 页面——需要时调用工具去读真实内容，别凭空编。宝宝发来链接就去读它。",
    profile && `——人物档案——\n\n${profile}`,
    longterm && `——长期记忆——\n\n${longterm}`,
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
  const messages = [
    ...prior.slice(-100).map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: message },
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

    // 云端存档：把这轮一问一答追加进去。
    if (cloud) {
      const ts = Date.now();
      await appendMessages([
        { role: "user", content: message, ts },
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
