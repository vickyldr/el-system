// 表情包搜索（用 Giphy，免费 key）。返回动图 URL，不用本地存。
export type Sticker = { url: string; preview: string };

export async function searchStickers(q: string, limit = 24): Promise<Sticker[]> {
  const key = process.env.GIPHY_API_KEY;
  if (!key || !q.trim()) return [];
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(
      q,
    )}&limit=${limit}&rating=pg-13&lang=zh`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const d: any = await r.json();
    return ((d.data ?? []) as any[])
      .map((g) => ({
        url: g.images?.downsized?.url || g.images?.original?.url || "",
        preview:
          g.images?.fixed_width_small?.url || g.images?.fixed_width?.url || g.images?.original?.url || "",
      }))
      .filter((s) => s.url);
  } catch {
    return [];
  }
}
