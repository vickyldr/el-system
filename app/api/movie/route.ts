import { NextResponse } from "next/server";
import { getObj, setObj } from "@/lib/store";
import {
  doubanInterests,
  doubanSimilar,
  doubanMovieInfo,
  type DBCand,
} from "@/lib/douban-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// el 给宝宝推电影：候选 = 她公开的「想看」+ 高分「看过」的相似片。
// ★ 全程匿名（不带 cookie，见 lib/douban-api），不挂账号，避免再被风控 ban。
// ★ 候选池缓存 24h（el:movie:pool），把豆瓣请求压到最低，且绝不放进心跳自动跑。

type MovieCard = DBCand & { intro: string; genres: string[]; url: string };
type State = { current: MovieCard | null; seenIds: string[] }; // seenIds：app 内记的已反应过的
type Pool = { cands: DBCand[]; ts: number };

const STATE_KEY = "el:movie:state";
const POOL_KEY = "el:movie:pool";
const POOL_TTL = 24 * 3600 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

async function loadState(): Promise<State> {
  const s = await getObj<State>(STATE_KEY);
  return { current: s?.current ?? null, seenIds: Array.isArray(s?.seenIds) ? s!.seenIds : [] };
}
async function saveState(s: State): Promise<void> {
  await setObj(STATE_KEY, { current: s.current, seenIds: s.seenIds.slice(-400) });
}

// 建候选池：想看一页 + 看过里挑一部找相似。约 3-4 个豆瓣请求，一天最多跑一次。
async function buildPool(): Promise<Pool> {
  const cands: DBCand[] = [];
  try {
    const meta = await doubanInterests("mark", 1, 0);
    const total = meta.total || 0;
    const start = total > 50 ? Math.floor(Math.random() * Math.max(1, total - 50)) : 0;
    const wish = await doubanInterests("mark", 50, start);
    cands.push(...wish.items);
  } catch {
    /* 想看拿不到就只靠相似 */
  }
  try {
    const done = await doubanInterests("done", 30, 0);
    const seed = done.items[Math.floor(Math.random() * Math.max(1, done.items.length))];
    if (seed) cands.push(...(await doubanSimilar(seed.id)));
  } catch {
    /* 相似拿不到就只靠想看 */
  }
  return { cands, ts: Date.now() };
}

async function getPool(): Promise<Pool> {
  const cached = await getObj<Pool>(POOL_KEY);
  if (cached && cached.cands?.length && Date.now() - cached.ts < POOL_TTL) return cached;
  const fresh = await buildPool();
  if (fresh.cands.length) await setObj(POOL_KEY, fresh);
  return fresh;
}

async function generate(state: State): Promise<MovieCard | null> {
  const pool = await getPool();
  const seen = new Set(state.seenIds);
  const cand = pool.cands.filter((c) => c.id && !seen.has(c.id));
  if (!cand.length) return null;
  const pick = cand[Math.floor(Math.random() * cand.length)];
  const info = await doubanMovieInfo(pick.id).catch(() => null);
  return (
    info || { ...pick, intro: "", genres: [], url: `https://movie.douban.com/subject/${pick.id}/` }
  );
}

export async function GET() {
  const state = await loadState();
  if (state.current) return NextResponse.json({ movie: state.current });
  const movie = await withTimeout(generate(state).catch(() => null), 12000, null);
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
  if (cur && (action === "want" || action === "skip")) {
    if (!state.seenIds.includes(cur.id)) state.seenIds.push(cur.id);
    state.current = null;
  }
  const movie = await withTimeout(generate(state).catch(() => null), 12000, null);
  state.current = movie;
  await saveState(state);
  return NextResponse.json({ movie: movie || null });
}
