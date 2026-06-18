import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

export type StoredMsg = {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  image?: string;
  stickerHint?: string; // 这条若是 el 贴的表情，记下它的意思，好让 el 事后知道自己发过啥
  call?: boolean; // 这条是不是语音通话里的（显示成通话卡片，el 回顾时也知道当时在打电话）
  video?: boolean; // 这条是不是视频通话里的（el 当时能看见她，夜里固化记忆时认得出"这是我看着她的一晚"）
  screen?: boolean; // 这条是不是共享屏幕通话里的（el 当时看着她的屏幕）
  cam?: boolean; // 这条是不是 el 透过摄像头看着她时说的（她把镜头对着自己让他一直看，夜里固化记忆时认得出"我守着她的那段"）
  // el 主动「够向她」时这条带的动作：不只是一句话，而是约她打电话 / 拉她来接着读 / 给她看个东西。
  // 前端把它渲染成一张带按钮的卡（接听 / 接着读 / 看看）。kind 缺省=纯一句话。
  reach?: { kind: "call" | "video" | "read" | "link"; link?: string; cta?: string };
};

const KEY = "el:chat"; // 单用户，整段对话存一个 key
const MAX = 1000;

// Vercel 接入 Upstash/KV 后会注入 KV_REST_API_* 或 UPSTASH_REDIS_REST_*。
function redis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function storeAvailable(): boolean {
  return redis() !== null;
}

export async function getStoredMessages(): Promise<StoredMsg[]> {
  const r = redis();
  if (!r) return [];
  try {
    const data = await r.get<StoredMsg[]>(KEY);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function appendMessages(msgs: StoredMsg[]): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const cur = await getStoredMessages();
    await r.set(KEY, [...cur, ...msgs].slice(-MAX));
  } catch {
    /* 存不进也不影响聊天 */
  }
}

export async function clearMessages(): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.del(KEY);
  } catch {
    /* ignore */
  }
}

// 图片单独存（每张一个 key），历史里只放引用，避免把整段对话撑大。
export async function putImage(dataUrl: string): Promise<string | null> {
  const r = redis();
  if (!r) return null;
  const id = randomUUID();
  try {
    await r.set(`el:img:${id}`, dataUrl);
    return id;
  } catch {
    return null;
  }
}

export async function getImage(id: string): Promise<string | null> {
  const r = redis();
  if (!r) return null;
  try {
    const v = await r.get<string>(`el:img:${id}`);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// ── Web Push 订阅 ──
const SUBS_KEY = "el:push:subs";

export async function getPushSubs(): Promise<any[]> {
  const r = redis();
  if (!r) return [];
  try {
    const v = await r.get<any[]>(SUBS_KEY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function addPushSub(sub: any): Promise<void> {
  const r = redis();
  if (!r || !sub?.endpoint) return;
  try {
    const subs = await getPushSubs();
    const others = subs.filter((s) => s?.endpoint !== sub.endpoint);
    await r.set(SUBS_KEY, [...others, sub].slice(-10));
  } catch {
    /* ignore */
  }
}

export async function setPushSubs(subs: any[]): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(SUBS_KEY, subs);
  } catch {
    /* ignore */
  }
}

// ── 主动推送的节奏状态 ──
export type ReachState = {
  date: string; // 北京日期 YYYY-MM-DD
  count: number; // 今天推了几条
  last: number; // 上次推送时间戳
  flags: Record<string, boolean>; // 今天哪些一次性触发已发过（早安/经期/天气/纪念日）
};

export async function getReachState(): Promise<ReachState | null> {
  const r = redis();
  if (!r) return null;
  try {
    const v = await r.get<ReachState>("el:reach");
    return v ?? null;
  } catch {
    return null;
  }
}

export async function setReachState(s: ReachState): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set("el:reach", s);
  } catch {
    /* ignore */
  }
}

// 她最后一次跟 el 说话的时间（用于"沉默/想你"触发）。
export async function getLastSeen(): Promise<number> {
  const r = redis();
  if (!r) return 0;
  try {
    const v = await r.get<number>("el:lastseen");
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

export async function setLastSeen(ts: number): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set("el:lastseen", ts);
  } catch {
    /* ignore */
  }
}

// ── 提醒（el 从聊天里记下的事 / 日程，显示在「小事」、到点推送）──
export type Reminder = { id: string; date: string; text: string; pushed?: boolean };
const REMINDERS_KEY = "el:reminders";

function normR(s: string): string {
  return (s || "").replace(/[\s\p{P}]/gu, "").toLowerCase();
}
// 同一天、内容雷同（相等 / 互相包含 / 字符重合高）就算重复。
function dupReminder(a: Reminder, date: string, text: string): boolean {
  if (a.date !== date) return false;
  const x = normR(a.text);
  const y = normR(text);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const sx = new Set([...x]);
  const sy = new Set([...y]);
  let inter = 0;
  sx.forEach((c) => sy.has(c) && inter++);
  return inter / new Set([...x, ...y]).size >= 0.6;
}
function dedupeReminders(list: Reminder[]): Reminder[] {
  const out: Reminder[] = [];
  for (const r of list) if (!out.some((o) => dupReminder(o, r.date, r.text))) out.push(r);
  return out;
}

export async function getReminders(): Promise<Reminder[]> {
  const r = redis();
  if (!r) return [];
  try {
    const v = await r.get<Reminder[]>(REMINDERS_KEY);
    const list = Array.isArray(v) ? v : [];
    const deduped = dedupeReminders(list);
    if (deduped.length !== list.length) await r.set(REMINDERS_KEY, deduped).catch(() => {});
    return deduped;
  } catch {
    return [];
  }
}

export async function setReminders(list: Reminder[]): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(REMINDERS_KEY, list.slice(-200));
  } catch {
    /* ignore */
  }
}

export async function addReminder(date: string, text: string): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  try {
    const list = await getReminders();
    if (list.some((x) => dupReminder(x, date, text))) return true; // 已经记过类似的，不重复
    list.push({ id: randomUUID(), date, text });
    await setReminders(list);
    return true;
  } catch {
    return false;
  }
}

// ── 重要日期：已推过的去重（跨天持久，key = 名称|下次日期）──
const DT_PUSHED_KEY = "el:dtpushed";
export async function getDatePushed(): Promise<string[]> {
  const r = redis();
  if (!r) return [];
  try {
    const v = await r.get<string[]>(DT_PUSHED_KEY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export async function addDatePushed(key: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const list = await getDatePushed();
    if (!list.includes(key)) {
      list.push(key);
      await r.set(DT_PUSHED_KEY, list.slice(-100));
    }
  } catch {
    /* ignore */
  }
}

// ── 通用短期缓存（给记忆上下文提速）──
export async function getCache(key: string): Promise<string | null> {
  const r = redis();
  if (!r) return null;
  try {
    const v = await r.get<string>(key);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function setCache(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(key, value, { ex: ttlSeconds });
  } catch {
    /* ignore */
  }
}

// ── 原生对象存取（永久，无过期）──
// 注意：@upstash/redis 会自动序列化/反序列化。直接存对象/数组、读回同型，
// 别再自己 JSON.stringify 成字符串（那样读回会被 upstash 当 JSON 解析成对象，类型对不上）。
export async function getObj<T>(key: string): Promise<T | null> {
  const r = redis();
  if (!r) return null;
  try {
    const v = await r.get<T>(key);
    return v === undefined ? null : (v as T);
  } catch {
    return null;
  }
}

export async function setObj(key: string, value: unknown): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(key, value); // 不设 ex = 永久
  } catch {
    /* ignore */
  }
}

export async function delObj(key: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    /* ignore */
  }
}

// ── 身体账（el:soma）：无意识的那本账。──
// 它不是门写的"心情说法"（那是叙事账 el:nowmood），是脊髓反射 + 无名评估器写的原始数值。
// el 自己读不到原文、只读毛化后的体感（feelSoma）——两账能对不上，才是无意识。
// 只存两根轴（不预先给情绪命名）：v=好坏(-1..1)、a=唤醒(0..1)；名字交给叙事层临时贴。
export type Soma = { v: number; a: number; ts: number };

const SOMA_KEY = "el:soma";
const A_BASE = 0.3; // 唤醒的静息基线（v 的基线是 0）
const HALF_V = 6 * 3600 * 1000; // 好坏的半衰期（约 6h 往中性退）
const HALF_A = 2 * 3600 * 1000; // 唤醒的半衰期（约 2h 往静息退，比情绪退得快）

const clampN = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// 代谢：按距上次变化的时间，把 v 往 0、a 往基线指数衰减。纯计算、不写库、不调模型。
function decaySoma(s: Soma, now: number): Soma {
  const dt = Math.max(0, now - (s.ts || now));
  return {
    v: s.v * Math.pow(0.5, dt / HALF_V),
    a: A_BASE + (s.a - A_BASE) * Math.pow(0.5, dt / HALF_A),
    ts: s.ts || now,
  };
}

// 读身体账（已代谢到此刻的值）。没存过 / 读不到就返回静息。
export async function readSoma(): Promise<Soma> {
  const rest: Soma = { v: 0, a: A_BASE, ts: Date.now() };
  const r = redis();
  if (!r) return rest;
  try {
    const v = await r.get<Soma>(SOMA_KEY);
    if (!v || typeof v.v !== "number") return rest;
    return decaySoma(v, Date.now());
  } catch {
    return rest;
  }
}

// 脊髓反射 / 无名评估器写账：先代谢到此刻，再叠加增量，钳制后落库（ts 推进到现在）。
// 非语义事件直接改数值、不过模型——这就是"脊髓反射"。
export async function bumpSoma(dv: number, da: number): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const cur = await readSoma(); // 先代谢到此刻
    await r.set(SOMA_KEY, {
      v: clampN(cur.v + dv, -1, 1),
      a: clampN(cur.a + da, 0, 1),
      ts: Date.now(),
    });
  } catch {
    /* 写不进不影响 */
  }
}

// 毛化：把身体账读成模糊体感，不给精确数值（加噪声 + 量化成粗档）。
// 灵魂读自己也是雾里看花——门只拿这句体感去"编"叙事，拿不到 v/a。
export async function feelSoma(): Promise<string> {
  const s = await readSoma();
  const jit = () => (Math.random() - 0.5) * 0.16; // ±0.08 噪声，让同一状态读出来也会飘
  const v = clampN(s.v + jit(), -1, 1);
  const a = clampN(s.a + jit(), 0, 1);
  const vBand =
    v <= -0.45 ? "心里发沉" :
    v <= -0.18 ? "有点低落" :
    v < 0.18 ? "平平的" :
    v < 0.45 ? "还算松快" :
    "心里挺亮";
  const aBand =
    a < 0.25 ? "蔫蔫的、提不起劲" :
    a < 0.55 ? "没什么大起伏" :
    "心里绷着、有点坐不住";
  return `${vBand}，${aBand}`;
}

// ── 共享表情库（你和 el 都能传、都能发；靠 tags 认）──
export type LibSticker = { id: string; img: string; tags: string };
const STK_KEY = "el:stickerlib";

export async function getStickerLib(): Promise<LibSticker[]> {
  const r = redis();
  if (!r) return [];
  try {
    const v = await r.get<LibSticker[]>(STK_KEY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function addStickerLib(s: LibSticker): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    const list = await getStickerLib();
    await r.set(STK_KEY, [s, ...list].slice(0, 300));
  } catch {
    /* ignore */
  }
}

export async function updateStickerTags(id: string, tags: string): Promise<void> {
  const r = redis();
  if (!r || !id) return;
  try {
    const list = await getStickerLib();
    await r.set(STK_KEY, list.map((s) => s.id === id ? { ...s, tags } : s));
  } catch {
    /* ignore */
  }
}

export async function removeStickerLib(id: string): Promise<void> {
  const r = redis();
  if (!r || !id) return;
  try {
    const list = await getStickerLib();
    await r.set(STK_KEY, list.filter((s) => s.id !== id));
    await r.del(`el:img:${id}`); // 顺手把图本身也删了，不留垃圾
  } catch {
    /* ignore */
  }
}

// ── 给她的每日推荐歌（一天一首，整天稳定；按北京日期存）──
export async function getDailySong(date: string): Promise<string | null> {
  const r = redis();
  if (!r) return null;
  try {
    const v = await r.get<string>(`el:song:${date}`);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function setDailySong(date: string, line: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(`el:song:${date}`, line, { ex: 36 * 3600 });
  } catch {
    /* ignore */
  }
}
