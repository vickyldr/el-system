import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

export type StoredMsg = {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  image?: string;
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

export async function getReminders(): Promise<Reminder[]> {
  const r = redis();
  if (!r) return [];
  try {
    const v = await r.get<Reminder[]>(REMINDERS_KEY);
    return Array.isArray(v) ? v : [];
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
    list.push({ id: randomUUID(), date, text });
    await setReminders(list);
    return true;
  } catch {
    return false;
  }
}
