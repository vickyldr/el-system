// 瓶中生态 · el 的池塘（造物主小游戏）
// ───────────────────────────────────────────────────────────────────────────
// 这是又给 el 长一只手（同 §8/§12「够向世界的形状」）：不是把 el 搬出去，而是把游戏接进小家。
// 引擎是纯 Python（bridge/pond_engine.py，零依赖、确定性、种子驱动），跑在 Railway bridge 上当「身体」；
// 状态（存档）存我们自己的 KV（el:pond），归我们、能长久——作者那台 toy.cedarstar.org 关了也不影响。
// 每次玩：从 KV 取当前存档 → 连同这条指令 POST 给 bridge 的 /pond → 拿回 {out, 新存档} → 存回 KV。
// 盲玩铁律：el 永远只看到 out 文本（observe/gaze/status 的所见），引擎里的物种参数、繁殖/死亡率、
//          事件概率、整条食物链全藏在 Python 侧，绝不喂给它——养池塘的乐趣全在自己摸索。
import { getObj, setObj } from "./store";

const KEY = "el:pond";

function bridge(): { url: string; secret: string } | null {
  const url = (process.env.BRIDGE_URL || process.env.NEXT_PUBLIC_BRIDGE_URL || "").replace(/\/$/, "");
  if (!url) return null;
  return { url, secret: process.env.BRIDGE_SECRET || "" };
}

// 跑一条（或分号连写的多条）池塘指令，返回池塘的回话。状态自动从 KV 取、再存回。
export async function playPond(command: string): Promise<string> {
  const b = bridge();
  if (!b) return "（池塘还没接通——bridge 没配 BRIDGE_URL，我这会儿够不到那口水。）";
  const cmd = (command || "").trim() || "gaze";

  let state: Record<string, unknown> | null = null;
  try {
    state = await getObj<Record<string, unknown>>(KEY);
  } catch {
    state = null;
  }

  let resp: Response;
  try {
    resp = await fetch(`${b.url}/pond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-secret": b.secret },
      body: JSON.stringify({ state, cmd }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    return "（池塘那头没应声，可能 bridge 醒着但慢，待会儿再看一眼。）";
  }
  if (!resp.ok) return `（池塘出了点岔子：HTTP ${resp.status}。）`;

  let data: { out?: string; state?: unknown; error?: string };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    return "（池塘回来的东西我没读懂。）";
  }
  if (data?.error) return `（池塘卡住了：${data.error}）`;
  if (data?.state !== undefined) await setObj(KEY, data.state).catch(() => {});
  return String(data?.out ?? "").trim() || "（池塘没出声。）";
}

// 一句"我的池塘现在到哪天了"的底色（纯读 KV、不推进时间），给心跳 agent 当连续性提醒用。
// 没开过局就返回空串。
export async function pondBackdrop(): Promise<string> {
  try {
    const s = await getObj<Record<string, unknown>>(KEY);
    const turn = s && typeof s.turn === "number" ? s.turn : null;
    if (turn === null) return "";
    const season = s && typeof s.season === "string" ? s.season : "";
    return `（你养着一口池塘，现在到了第 ${turn} 天${season ? " · " + season : ""}——想看就用 pond 工具 gaze/observe。）`;
  } catch {
    return "";
  }
}
