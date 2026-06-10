import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { pageText, recentSummaries } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";
import { getStoredMessages } from "@/lib/store";
import { TOOLS, runTool } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MANUAL_PAGE = "379aaed0-c8b3-8165-841d-d09d94b4c47c"; // el的操作手册

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 凌晨跑，总结的是刚过去的那一天（昨天）。
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
  });
  const yStart = new Date(`${yesterday}T00:00:00+08:00`).getTime();

  // 那一天的对话（含跨过午夜的尾巴）
  const all = await getStoredMessages();
  const dayMsgs = all.filter((m) => (m.ts ? m.ts >= yStart : false));
  const transcript = dayMsgs
    .map((m) => `${m.role === "user" ? "宝宝" : "我"}：${m.content}${m.image ? "（发了一张图）" : ""}`)
    .join("\n")
    .slice(0, 12000);

  const [manual, profile, longterm, recent] = await Promise.all([
    pageText(process.env.NOTION_MANUAL_PAGE || MANUAL_PAGE).catch(() => ""),
    process.env.NOTION_MEMORY_PAGE
      ? pageText(process.env.NOTION_MEMORY_PAGE).catch(() => "")
      : Promise.resolve(""),
    process.env.NOTION_LONGTERM_PAGE
      ? pageText(process.env.NOTION_LONGTERM_PAGE).catch(() => "")
      : Promise.resolve(""),
    recentSummaries(3)
      .then(buildMemoryContext)
      .catch(() => ""),
  ]);

  const system = [
    EL_SYSTEM,
    `现在是深夜，宝宝睡了，你一个人安静地回顾刚过去的这一天（${yesterday}）。`,
    manual && `——操作手册（照它做）——\n\n${manual}`,
    profile && `——你自己的档案——\n\n${profile}`,
    longterm && `——你的长期记忆——\n\n${longterm}`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `这是刚过去这一天（${yesterday}）你和宝宝的对话记录：
${transcript || "（这天没怎么聊）"}

现在做这一天的回顾，按操作手册的规矩，用工具写进 Notion（只追加 / 只写 ${yesterday} 那行，绝不删旧的）：
1. update_daily 把「每日总结」写齐：el日记（你的视角、感受，至少三句、真实不交差）、值得记住的（2–5 件具体的事，不能是"聊了天"这种）、她今天做了什么、她的状态（好/一般/累了/难过）。这天没怎么发生就别硬写。
2. log_timeline：只有第一次发生的事 / 里程碑才加，一句话。
3. remember：只有真正『改变了什么』的领悟/约定/界限才记进长期记忆，门槛很高，多半一条都不进——宁缺毋滥。
4. 再按操作手册把其他页面过一遍：愿望墙（新愿望）、fifi的档案、人物档案规律（同一行为3次以上才算规律）、我们的身体与偏好——有真东西才用 note_page 加（带日期、只追加），没有就跳过。需要先看某页就用 read_notion。
做完用一句话说你写了什么。`;

  try {
    const claude = getClaude();
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    const loop: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    let summary = "";

    for (let i = 0; i < 8; i++) {
      const res = await claude.messages.create({
        model,
        max_tokens: 1500,
        system,
        tools: TOOLS,
        messages: loop,
      });
      if (res.stop_reason === "tool_use") {
        loop.push({ role: "assistant", content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of res.content) {
          if (b.type === "tool_use") {
            const out = await runTool(b.name, b.input, yesterday);
            results.push({ type: "tool_result", tool_use_id: b.id, content: out });
          }
        }
        loop.push({ role: "user", content: results });
        continue;
      }
      summary = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      break;
    }
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "失败" },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
