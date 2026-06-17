import { NextResponse } from "next/server";
import { getObj, setObj } from "@/lib/store";
import { doubanPeople, type DBCand } from "@/lib/douban-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// el 给宝宝推电影：从她公开的「想看」里挑（看过兜底）。
// ★ 走豆瓣网页版（UTF-8 中文正常，不像 frodo 那条会乱码）、全程匿名不带 cookie、不挂账号。
// ★ 候选池缓存 24h，请求压到最低，且绝不放进心跳自动跑。

type MovieCard = DBCand & { intro: string; genres: string[]; url: string };
type State = { current: MovieCard | null; seenIds: string[] };
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

const toCand = (x: { id: string; title: string; cover: string }): DBCand => ({
  id: x.id,
  title: x.title,
  year: "",
  rating: null,
  cover: x.cover,
});

// 候选池：想看为主、看过兜底。约 1-2 个网页请求，一天最多一次。
async function buildPool(): Promise<Pool> {
  const cands: DBCand[] = [];
  try {
    const wish = await doubanPeople("wish", 50, 0);
    cands.push(...wish.items.map(toCand));
  } catch {
    /* 想看读不到就兜底看过 */
  }
  if (!cands.length) {
    try {
      const done = await doubanPeople("collect", 50, 0);
      cands.push(...done.items.map(toCand));
    } catch {
      /* 都读不到就空池 */
    }
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
  return { ...pick, intro: "", genres: [], url: `https://movie.douban.com/subject/${pick.id}/` };
}

// 自检：/api/movie?debug=1 当场看网页版能不能匿名读到想看/看过（中文应正常）。
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("debug") === "1") {
    const out: any = { uidConfigured: !!process.env.DOUBAN_USER_ID, cookieSent: false };
    try {
      const w = await doubanPeople("wish", 5, 0);
      out.wish = { total: w.total, sample: w.items.slice(0, 5).map((x) => x.title) };
    } catch (e) {
      out.wish = { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
    try {
      const d = await doubanPeople("collect", 5, 0);
      out.done = { total: d.total, sample: d.items.slice(0, 5).map((x) => x.title) };
    } catch (e) {
      out.done = { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
    return NextResponse.json(out);
  }

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
