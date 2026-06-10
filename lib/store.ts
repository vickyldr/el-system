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
