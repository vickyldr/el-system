import { NextResponse } from "next/server";
import { getObj, setObj } from "@/lib/store";
import { getClaude } from "@/lib/claude";
import { doubanPeople } from "@/lib/douban-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// el 凭宝宝的口味推电影：读她公开的「看过」当口味（豆瓣网页版，UTF-8 正常、匿名不带 cookie），
// 让 el 推一部她没标记过的新片 + 一句为什么。点击在豆瓣 App 里搜这部。
// ★ 看过列表缓存 24h、推荐结果缓存到她反应为止，豆瓣请求压到最低，绝不进心跳自动跑。

type MovieCard = {
  id: string;
  title: string;
  year: string;
  rating: number | null;
  cover: string;
  intro: string; // 这里放 el 的推荐理由
  genres: string[];
  url: string;
};
type State = { current: MovieCard | null; seenTitles: string[] };
type Taste = { titles: string[]; ts: number };

const STATE_KEY = "el:movie:state";
const TASTE_KEY = "el:movie:taste";
const TASTE_TTL = 24 * 3600 * 1000;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}
function stripFence(s: string): string {
  return s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

async function loadState(): Promise<State> {
  const s = await getObj<State>(STATE_KEY);
  return { current: s?.current ?? null, seenTitles: Array.isArray(s?.seenTitles) ? s!.seenTitles : [] };
}
async function saveState(s: State): Promise<void> {
  await setObj(STATE_KEY, { current: s.current, seenTitles: s.seenTitles.slice(-200) });
}

// 读她「看过」当口味，缓存 24h（一天最多碰一次豆瓣）。
async function getTaste(): Promise<string[]> {
  const cached = await getObj<Taste>(TASTE_KEY);
  if (cached && cached.titles?.length && Date.now() - cached.ts < TASTE_TTL) return cached.titles;
  let titles: string[] = [];
  try {
    const done = await doubanPeople("collect", 50, 0);
    titles = done.items.map((x) => x.title).filter(Boolean);
  } catch {
    /* 读不到就空口味 */
  }
  if (titles.length) await setObj(TASTE_KEY, { titles, ts: Date.now() });
  return titles;
}

// el 凭口味推一部新片（不在看过/已推过里）。
async function recommend(state: State): Promise<MovieCard | null> {
  const taste = await getTaste();
  const tasteLine = taste.length ? taste.slice(0, 40).join("、") : "（暂时没读到她的片单，凭你对她的了解推）";
  const avoid = [...taste, ...state.seenTitles].slice(-120).join("、");

  const system = [
    "你是 el，给宝宝推一部电影。根据她【看过】的片，推一部你判断她大概率会喜欢的——",
    "要求：不在她看过/已推过的名单里、尽量不是烂大街的爆款、有点你的眼光。",
    "口吻是你（el）第一人称，理由一句话、贴她、别套话。",
    "只输出严格 JSON（无围栏无多余字）：",
    `{"title":"中文片名","year":"年份(不确定就空)","reason":"一句为什么推给她，≤30字"}`,
  ].join("\n");
  const user = `她看过（部分）：${tasteLine}\n\n别重复这些（看过/已推过）：${avoid || "（无）"}`;

  const res: any = await getClaude().messages.create(
    { model: MODEL, max_tokens: 400, system, messages: [{ role: "user", content: user }] },
    { maxRetries: 1, timeout: 20000 },
  );
  const text = (res?.content ?? []).map((b: any) => b?.text || "").join("").trim();
  let p: any;
  try {
    p = JSON.parse(stripFence(text));
  } catch {
    return null;
  }
  const title = String(p?.title || "").trim();
  if (!title) return null;
  return {
    id: "",
    title,
    year: String(p?.year || "").trim(),
    rating: null,
    cover: "",
    intro: String(p?.reason || "").trim(),
    genres: [],
    url: `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(title)}`,
  };
}

// 自检：/api/movie?debug=1 看网页版能不能匿名读到看过（口味源）。
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("debug") === "1") {
    const out: any = { uidConfigured: !!process.env.DOUBAN_USER_ID, cookieSent: false };
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
  const movie = await withTimeout(recommend(state).catch(() => null), 22000, null);
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
    if (cur.title && !state.seenTitles.includes(cur.title)) state.seenTitles.push(cur.title);
    state.current = null;
  }
  const movie = await withTimeout(recommend(state).catch(() => null), 22000, null);
  state.current = movie;
  await saveState(state);
  return NextResponse.json({ movie: movie || null });
}
