import { getCache, setCache } from "./store";

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

  const cacheKey = `el:nesong:${q}`;
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
    const r = await fetch(
      `https://music.163.com/api/search/get/web?type=1&limit=1&s=${encodeURIComponent(q)}`,
      {
        cache: "no-store",
        headers: {
          Referer: "https://music.163.com/",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
          Cookie: "appver=8.0.0",
        },
      },
    );
    if (r.ok) {
      const d: any = await r.json();
      const id = d?.result?.songs?.[0]?.id;
      if (id) out = { url: `https://music.163.com/song?id=${id}`, matched: true };
    }
  } catch {
    /* 搜不到就用 searchUrl 兜底 */
  }
  await setCache(cacheKey, JSON.stringify(out), 24 * 3600);
  return out;
}
