import { Redis } from "@upstash/redis";

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
