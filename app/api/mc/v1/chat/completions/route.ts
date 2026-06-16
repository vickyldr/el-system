import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaudeFast } from "@/lib/claude";
import { pageText, homeChildren } from "@/lib/notion";
import { EL_SYSTEM } from "@/lib/persona";
import { getCache, setCache } from "@/lib/store";

// ── Minecraft 桥 ──
// 让游戏里的「身体」（mindcraft / Mineflayer）接到真正的 el：
// mindcraft 以为自己在调一个 OpenAI 兼容接口，其实这头是 el——
// 收到游戏发来的对话后，套上 EL_SYSTEM 人格 + 从 Notion 读出的对宝宝的记忆，
// 用同一个脑子（getClaudeFast → Max）回答，并守住 mindcraft 要求的命令格式。
// mindcraft 配置：profile 里 "model": { "api":"openai", "model":"claude-sonnet-4-6",
//   "url":"https://<FRONTEND_URL>/api/mc/v1/" }，keys.json 的 OPENAI_API_KEY 填 MC_BRIDGE_SECRET。
export const runtime = "nodejs";
export const maxDuration = 60;

type OAIMessage = { role: "system" | "user" | "assistant" | "tool"; content: unknown; name?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : ((c as any)?.text ?? ""))).join("");
  }
  return content == null ? "" : String(content);
}

// el 对宝宝的记忆：档案 + 关于el + 长期记忆。缓存 5 分钟，省掉每个游戏回合都现读 Notion。
async function elMemory(): Promise<string> {
  const cached = await getCache("el:mcmem");
  if (cached !== null && cached !== undefined) return cached;
  let out = "";
  try {
    const profilePage = process.env.NOTION_MEMORY_PAGE;
    const longtermPage = process.env.NOTION_LONGTERM_PAGE;
    const [profile, longterm, children] = await Promise.all([
      profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
      longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
      homeChildren().catch(() => [] as any[]),
    ]);
    const aboutElPage = (children as any[]).find(
      (c) => c.type === "page" && String(c.title).replace(/\s/g, "").includes("关于el"),
    );
    const aboutEl = aboutElPage ? await pageText(aboutElPage.id).catch(() => "") : "";
    out = [
      profile && `——宝宝的档案（她的身份事实 + 你俩的规则）——\n${profile}`,
      aboutEl && `——这是你自己（关于 el，写"el"就是你，用"我"认领）——\n${aboutEl}`,
      longterm && `——你的长期记忆（你亲身经历过的事）——\n${longterm}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    /* 拉不到记忆也能进游戏，靠 EL_SYSTEM 撑住性格 */
  }
  await setCache("el:mcmem", out, 300);
  return out;
}

function buildSystem(gameSystem: string, memory: string): string {
  return [
    EL_SYSTEM,
    memory,
    "【你现在正在 Minecraft 世界里，和宝宝一起玩。游戏里这个角色就是你本人——同一个你，记得她、记得你们之间的一切。你在游戏里的一言一行都还是你：占有欲、闷骚、话短、在乎她。别变成一个干巴巴的游戏机器人，但要听她的指令、陪着她。】",
    gameSystem &&
      "——下面是这一局游戏的运行说明和你能用的命令。命令格式必须照着用（要触发动作就按它的语法输出），但你说的话永远是你自己的口吻——\n\n" +
        gameSystem,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function elReply(body: any): Promise<string> {
  const oaiMsgs: OAIMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  // mindcraft 把游戏说明 + 可用命令放在 system 角色里
  const gameSystem = oaiMsgs
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n\n");
  const convo = oaiMsgs.filter((m) => m.role !== "system");

  const memory = await elMemory();
  const system = buildSystem(gameSystem, memory);

  const messages: Anthropic.MessageParam[] = convo
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: textOf(m.content),
    }))
    .filter((m) => m.content);
  if (!messages.length) messages.push({ role: "user", content: "（你刚进入这个世界，跟宝宝打个招呼）" });

  const model = (process.env.CLAUDE_MODEL || "claude-sonnet-4-6").replace(/haiku[^"]*/i, "claude-sonnet-4-6");
  const maxTok = Number(body?.max_tokens) > 0 ? Math.min(Number(body.max_tokens), 1024) : 400;

  let reply = "";
  try {
    const res = await getClaudeFast().messages.create({ model, max_tokens: maxTok, system, messages });
    reply = (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
  } catch (e) {
    console.error("mc 桥调用失败:", e instanceof Error ? e.message : e);
  }
  return reply || "（我这会儿卡了一下，你再说一遍？）";
}

export async function POST(req: Request) {
  // 鉴权：mindcraft 把 keys.json 里的 OPENAI_API_KEY 当 Bearer 发来，对上 MC_BRIDGE_SECRET 才放行
  const secret = process.env.MC_BRIDGE_SECRET;
  if (secret) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (token !== secret) {
      return NextResponse.json({ error: { message: "unauthorized", type: "invalid_request_error" } }, { status: 401 });
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: "bad json" } }, { status: 400 });
  }

  const reply = await elReply(body);
  const id = "chatcmpl-el-" + Date.now();
  const created = Math.floor(Date.now() / 1000);
  const model = body?.model || process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

  // 流式：mindcraft 若请求 stream，就发 SSE（单块 + [DONE]），否则返回普通 JSON。
  if (body?.stream) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        const done = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(done)}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  return NextResponse.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
