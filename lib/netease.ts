import { getCache, setCache } from "./store";

// 从 Vercel 机房 IP 直连网易云会被风控挡（460/空），所以查歌 id 走中国 VPS relay（配了就用）。
const RELAY_URL = process.env.RELAY_URL || process.env.NETEASE_RELAY || "";
const RELAY_SECRET = process.env.RELAY_SECRET || process.env.NETEASE_RELAY_SECRET || "";

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  if (RELAY_URL) {
    const r = await fetch(RELAY_URL.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(RELAY_SECRET ? { "X-Relay-Secret": RELAY_SECRET } : {}),
      },
      body: JSON.stringify({ url, headers }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`relay ${r.status}`);
    return (await r.json())?.body || "";
  }
  const r = await fetch(url, { cache: "no-store", headers });
  if (!r.ok) throw new Error(`${r.status}`);
  return await r.text();
}

// 把 el 推的歌（形如「《歌名》— 歌手」）清成一句搜索词。
function cleanQuery(rec: string): string {
  return (rec || "")
    .replace(/[《》]/g, " ")
    .replace(/[—\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 拿歌名去网易云搜，取第一首的 id，拼成"通用链接"——iPhone 装了网易云就直接开 App 落到这首歌。
// 搜不到就退回"用歌名在网易云里搜索"的链接，绝不死链。结果缓存一天。
export async function resolveNeteaseSong(
  rec: string,
): Promise<{ url: string; matched: boolean }> {
  const q = cleanQuery(rec);
  const searchUrl = `https://music.163.com/#/search/m/?s=${encodeURIComponent(q)}`;
  if (!q) return { url: searchUrl, matched: false };

  const cacheKey = `el:nesong3:${q}`; // v3：老搜索接口被加密了，改用 suggest/web 明文接口
  const cached = await getCache(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      /* ignore */
    }
  }

  let out = { url: searchUrl, matched: false };
  try {
    // /api/search/get/web 已被网易云加密（返回密文）；suggest/web 仍是明文，能拿到 id。
    // 走 relay（中国 IP），不然 Vercel 机房 IP 被风控挡、拿不到 id 就只能回落网页搜索。
    const body = await fetchText(
      `https://music.163.com/api/search/suggest/web?s=${encodeURIComponent(q)}`,
      {
        Referer: "https://music.163.com/",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      },
    );
    const d: any = JSON.parse(body || "{}");
    const id = d?.result?.songs?.[0]?.id;
    // orpheus:// 是网易云 App 的专属 scheme，直接唤起 App 落到这首歌；
    // 通用链接(https)在 PWA 里会被当网页打开，不行。
    if (id) out = { url: `orpheus://song/${id}`, matched: true };
  } catch {
    /* 搜不到就用 searchUrl 兜底 */
  }
  await setCache(cacheKey, JSON.stringify(out), 24 * 3600);
  return out;
}
