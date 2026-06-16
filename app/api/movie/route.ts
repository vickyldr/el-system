import { NextResponse } from "next/server";
import { getCache, setCache } from "@/lib/store";
import {
  doubanInterests,
  doubanWatchedIds,
  doubanSimilar,
  doubanMovieInfo,
  doubanMarkWish,
  type DBCand,
} from "@/lib/douban-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 快速失败：豆瓣那条路慢/挂时（cookie 过期、relay 卡），别让前端无限转圈，
// 超过 ms 就当「这会儿没有可推的」返回，前端立刻显示空状态而不是一直 loading。
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// el 给宝宝推电影：候选 = 她「想看」里抽 + frodo 拿她高分看过的片找相似；
// 过滤掉她「看过」的；她点 想看/不想看/看过 后推下一部。状态存 KV。
// （源③ el 私货推荐 + 点「想看」写进她真豆瓣 = 后续 Phase。）

type MovieCard = DBCand & { intro: string; genres: string[]; url: string };
type State = {
  current: MovieCard | null;
  seenIds: string[]; // 已经推过（她反应过）的，不重复推
  want: { id: string; title: string }[]; // 她点了想看的，记下来
};

const KEY = "el:movie:state";

async function loadState(): Promise<State> {
  const raw = await getCache(KEY).catch(() => "");
  if (raw) {
    try {
      const s = JSON.parse(raw);
      return { current: s.current ?? null, seenIds: s.seenIds ?? [], want: s.want ?? [] };
    } catch {
      /* 坏了就重置 */
    }
  }
  return { current: null, seenIds: [], want: [] };
}
async function saveState(s: State) {
  const trimmed = { ...s, seenIds: s.seenIds.slice(-600), want: s.want.slice(-200) };
  await setCache(KEY, JSON.stringify(trimmed), 60 * 24 * 3600).catch(() => {});
}

function dedup(cands: DBCand[]): DBCand[] {
  const seen = new Set<string>();
  const out: DBCand[] = [];
  for (const c of cands) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

async function generate(state: State): Promise<MovieCard | null> {
  const pool: DBCand[] = [];
  // 源①：她的「想看」（随机一页，让 600 多部都有机会冒出来，不只最近的）
  try {
    const meta = await doubanInterests("mark", 1, 0);
    const start = Math.floor(Math.random() * Math.max(1, meta.total - 50));
    const wish = await doubanInterests("mark", 50, start);
    pool.push(...wish.items);
  } catch {
    /* 拿不到想看就只靠相似 */
  }
  // 源②：从她高分看过的片找相似（发现她没标记过的新片）
  try {
    const start = Math.floor(Math.random() * 200);
    const done = await doubanInterests("done", 30, start);
    const highs = done.items.filter((x) => (done.ratings[x.id] || 0) >= 4);
    const seeds = highs.length ? highs : done.items;
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    if (seed) pool.push(...(await doubanSimilar(seed.id)));
  } catch {
    /* 拿不到相似就只靠想看 */
  }

  const watched = await doubanWatchedIds().catch(() => new Set<string>());
  const seen = new Set(state.seenIds);
  const cand = dedup(pool).filter((c) => !watched.has(c.id) && !seen.has(c.id));
  if (!cand.length) return null;
  const pick = cand[Math.floor(Math.random() * cand.length)];
  const info = await doubanMovieInfo(pick.id).catch(() => null);
  return info || { ...pick, intro: "", genres: [], url: `https://movie.douban.com/subject/${pick.id}/` };
}

export async function GET() {
  const state = await loadState();
  if (state.current) return NextResponse.json({ movie: state.current });
  const movie = await withTimeout(generate(state).catch(() => null), 10000, null);
  if (movie) {
    state.current = movie;
    await saveState(state);
  }
  return NextResponse.json({ movie: movie || null });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}) as any);
  const action = String(body?.action || ""); // want | skip
  const state = await loadState();
  const cur = state.current;
  let wrote: boolean | undefined;
  if (cur && (action === "want" || action === "skip")) {
    if (!state.seenIds.includes(cur.id)) state.seenIds.push(cur.id);
    if (action === "want" && !state.want.some((w) => w.id === cur.id)) {
      state.want.push({ id: cur.id, title: cur.title });
      // 写进她真豆瓣「想看」（配了主账户 cookie 才会真写；best-effort，不阻塞推下一部）
      const r = await doubanMarkWish(cur.id).catch(() => ({ ok: false, detail: "err" }));
      wrote = r.ok;
    }
    state.current = null;
  }
  const movie = await withTimeout(generate(state).catch(() => null), 10000, null);
  state.current = movie;
  await saveState(state);
  return NextResponse.json({ movie: movie || null, wrote });
}
