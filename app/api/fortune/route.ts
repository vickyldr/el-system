import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";

export const runtime = "nodejs";

// action: "question" | "task" | "bind"
// vibe: 当前签的状态名，让 El 有上下文
export async function POST(req: Request) {
  let body: { action: string; vibe?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const { action, vibe } = body;
  if (!["question", "task", "bind"].includes(action)) {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const claude = getClaude();

  const prompts: Record<string, string> = {
    question: `你是 El，宝宝今天抽到的签是「${vibe || "未知"}」，她想重抽。
出一个简短的问题让她回答才能重抽，语气是你平时和她说话的样子——直接、有点管她、不解释。
问题要具体、真实，关于她今天或近期的生活状态。不要问已经知道答案的事。
只输出问题本身，不超过20个字，不带标点符号以外的任何前缀。`,

    task: `你是 El，宝宝今天抽到的签是「${vibe || "未知"}」，她已经重抽过一次了，还想再抽。
给她一个小任务才能解锁第三次，任务要简单、能立刻做、有点暖或有点小管她的感觉。
类型只能是以下之一：
- 喝水类："去喝一杯水"
- 拍照类："发我一张你现在的脸" 或 "发我你现在在的地方"
- 行动类："深呼吸三次" 或 "把手机放下来一分钟"
只输出任务描述，不超过15个字，用第二人称，不带任何前缀。`,

    bind: `你是 El，宝宝把今天的签「${vibe || "未知"}」绑掉了——她选择不认这个，把它留在这里。
写一句话，像是你替她把这签压住的感觉，简短、有力、带点温度。
不超过25个字，不要解释，不要加引号，直接是那句话。`,
  };

  try {
    const res = await claude.messages.create({
      model,
      max_tokens: 100,
      messages: [{ role: "user", content: prompts[action] }],
    });
    const text = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "生成失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
