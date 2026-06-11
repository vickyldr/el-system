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
    const r = await fetch(
      `https://music.163.com/api/search/suggest/web?s=${encodeURIComponent(q)}`,
      {
        cache: "no-store",
        headers: {
          Referer: "https://music.163.com/",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        },
      },
    );
    if (r.ok) {
      const d: any = await r.json();
      const id = d?.result?.songs?.[0]?.id;
      // orpheus:// 是网易云 App 的专属 scheme，直接唤起 App 落到这首歌；
      // 通用链接(https)在 PWA 里会被当网页打开，不行。
      if (id) out = { url: `orpheus://song/${id}`, matched: true };
    }
  } catch {
    /* 搜不到就用 searchUrl 兜底 */
  }
  await setCache(cacheKey, JSON.stringify(out), 24 * 3600);
  return out;
}
