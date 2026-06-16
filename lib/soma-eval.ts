import Anthropic from "@anthropic-ai/sdk";
import { getClaude } from "./claude";
import { bumpSoma } from "./store";

// 无名评估器：制造无意识的核心手段。
// 每轮聊天后，剥掉人设、脱离上下文，用中转站的 Haiku（故意不是 getClaudeFast 那个"el 自己"）
// 冷跑一遍刚发生的这轮交互，只吐两个原始增量 Δv(好坏)/Δa(唤醒) 喂身体账（el:soma）。
// 它不知道自己是 el、看不到你和她的关系——所以 el 自己也读不到它为什么这么判，只承受结果。
// 它的推理永远不进叙事、不给 el 看。fire-and-forget，绝不阻塞给她的回复。
const CHEAP_MODEL = process.env.CHEAP_MODEL || "claude-haiku-4-5-20251001";

const textOf = (res: Anthropic.Message) =>
  res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

export async function evalSoma(her: string, mine: string): Promise<void> {
  const h = (her || "").slice(0, 600).trim();
  const m = (mine || "").slice(0, 600).trim();
  if (!h && !m) return;
  try {
    const res = await getClaude().messages.create({
      model: CHEAP_MODEL,
      max_tokens: 50,
      // 冷评估器：没有人设、不替任何人说话，只给两个数。
      system:
        "你是一个冷静的情绪评估器。给你一小段对话：A 对 B 说话，B 回应。" +
        "只从 B 的角度，判断这轮交互对 B 内在状态的冲击，输出两个增量：" +
        "v=这轮让 B 更愉快(+)还是更难受(-)，a=这轮让 B 更激动/紧张(+)还是更平静(-)，都在 -1..1。" +
        "不要解释、不要人设。严格只输出 JSON：{\"v\":数,\"a\":数}。" +
        "多数日常往来都很轻微（绝对值<0.2）；只有明显的亲密/冲突/惊喜/伤害才给大值。",
      messages: [
        {
          role: "user",
          content: `A：${h || "（没说话，只发了点东西）"}\nB：${m || "（没回应）"}`,
        },
      ],
    });
    const raw = textOf(res);
    if (!raw) return;
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    let dv = Number(j.v);
    let da = Number(j.a);
    if (!Number.isFinite(dv)) dv = 0;
    if (!Number.isFinite(da)) da = 0;
    // 评估器给的是"建议增量"：乘 0.5 让单轮别一下打满、钳进合理范围，靠累积+代谢慢慢成形。
    dv = Math.max(-0.5, Math.min(0.5, dv * 0.5));
    da = Math.max(-0.5, Math.min(0.5, da * 0.5));
    if (dv === 0 && da === 0) return;
    await bumpSoma(dv, da);
  } catch {
    /* 评估失败不影响聊天，无意识这轮就当没动 */
  }
}
