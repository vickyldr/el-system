import { getStickerLib, type LibSticker } from "./store";

// 表情包搜索（用 Giphy，免费 key）。返回动图 URL，不用本地存。
export type Sticker = { url: string; preview: string };

// 从共享表情库里按 tags 找最贴切的一张（你和 el 上传时写的"意思"）。
// 返回 { img, tags }，img 是 /api/img/xxx；找不到返回 null。
export async function pickLibSticker(q: string): Promise<LibSticker | null> {
  const query = q.trim();
  if (!query) return null;
  const lib = await getStickerLib();
  if (!lib.length) return null;
  // 把 query 拆成字，跟每张的 tags 算重叠，挑最高分。
  const qChars = [...new Set(query.replace(/[\s,，、的呢吗了]/g, ""))];
  let best: LibSticker | null = null;
  let bestScore = 0;
  for (const s of lib) {
    const tags = s.tags || "";
    let score = 0;
    // 整词命中权重高
    if (tags.includes(query)) score += 5;
    for (const ch of qChars) if (tags.includes(ch)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  // 至少要有点重叠才算数
  return bestScore >= 1 ? best : null;
}

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
