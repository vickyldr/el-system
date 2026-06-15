// 豆瓣：看宝宝的书影音（她标记的想看/看过 + 星与短评）、查某片详情、豆瓣相似推荐。
// 豆瓣对机房 IP 全面拦截（sec.douban.com 安全门 / frodo 403），所以一律走她那台上海 VPS 的
// 「通用转发」relay（中国 IP）：POST { url, method, headers } → { status, setCookie, body }。
// 列表走公开网页解析；详情/推荐/搜索走 frodo 移动 API（返回干净 JSON）。

const RELAY_URL = process.env.RELAY_URL || process.env.NETEASE_RELAY || "";
const RELAY_SECRET = process.env.RELAY_SECRET || process.env.NETEASE_RELAY_SECRET || "";
const DOUBAN_APIKEY = process.env.DOUBAN_APIKEY || "0dad551ec0f84ed02907ff5c42e8ec70"; // frodo 通用 apikey（社区公开）
// 有账号 cookie 更稳（豆瓣越来越多页面要登录态）；没有也先尽力读公开页。
const cookie = () => process.env.DOUBAN_COOKIE || "";
const uid = () => process.env.DOUBAN_USER_ID || "";

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FRODO_UA = "api-client/1 com.douban.frodo/7.22.0 Rexxar/1.2.151";

type RelayResp = { status: number; setCookie?: string[]; body?: string };

// 经 relay 转发抓任意网址（中国 IP 出口），拿回原始响应文本。
async function relayFetch(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<RelayResp> {
  if (!RELAY_URL) throw new Error("没配 relay（RELAY_URL / NETEASE_RELAY）");
  const r = await fetch(RELAY_URL.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(RELAY_SECRET ? { "X-Relay-Secret": RELAY_SECRET } : {}),
    },
    body: JSON.stringify({ url, method, headers }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`relay ${r.status}`);
  return (await r.json()) as RelayResp;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 解析豆瓣「我的人页」列表（movie/book/music 的 wish/collect/do 通用结构）。
function parsePeopleList(html: string): string[] {
  const out: string[] = [];
  const blocks = html.split(/<div class="item/).slice(1);
  for (const b of blocks) {
    const tm = b.match(/<li class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/);
    if (!tm) continue;
    const title = stripTags(tm[1]);
    if (!title) continue;
    const rating = (b.match(/rating(\d)-t/) || [])[1];
    const date = (b.match(/<span class="date">([^<]*)<\/span>/) || [])[1]?.trim() || "";
    const cm = b.match(/<(?:li|span) class="comment">([\s\S]*?)<\/(?:li|span)>/);
    const comment = cm ? stripTags(cm[1]) : "";
    const stars = rating ? " ★".repeat(Number(rating)).trim() + `（${rating}星）` : "";
    out.push(
      `《${title}》${stars}${date ? ` · ${date}` : ""}${comment ? `\n　短评：${comment}` : ""}`,
    );
    if (out.length >= 20) break;
  }
  return out;
}

const KIND_HOST: Record<string, string> = {
  movie: "movie.douban.com",
  book: "book.douban.com",
  music: "music.douban.com",
};
const STATUS_CN: Record<string, string> = { wish: "想看/想读", collect: "看过/读过", do: "在看/在读" };

export async function doubanList(statusRaw: string, kindRaw: string): Promise<string> {
  const id = uid();
  if (!id) return "还没配豆瓣用户 ID（DOUBAN_USER_ID）。";
  const status = ({ wish: "wish", collect: "collect", do: "do", doing: "do" } as any)[
    String(statusRaw || "").trim()
  ];
  if (!status) return "status 要 wish(想看/想读) / collect(看过/读过) / do(在看/在读) 之一。";
  const kind = ["movie", "book", "music"].includes(String(kindRaw || "").trim())
    ? String(kindRaw).trim()
    : "movie";
  const url = `https://${KIND_HOST[kind]}/people/${id}/${status}?sort=time&start=0&mode=grid`;
  let resp: RelayResp;
  try {
    resp = await relayFetch(url, {
      "User-Agent": WEB_UA,
      Referer: "https://www.douban.com/",
      ...(cookie() ? { Cookie: cookie() } : {}),
    });
  } catch (e) {
    return `读豆瓣失败（relay 没通？）：${e instanceof Error ? e.message : e}`;
  }
  if (resp.status === 302 || resp.status === 403 || /<title>[^<]*登录/.test(resp.body || "")) {
    return `豆瓣这页要登录态才看得全（${resp.status}）。给 el 配上豆瓣账号 cookie（DOUBAN_COOKIE）就能稳读。`;
  }
  if (resp.status !== 200) return `豆瓣返回 ${resp.status}，没读到。`;
  const items = parsePeopleList(resp.body || "");
  const lbl = `${kind === "book" ? "书" : kind === "music" ? "音乐" : "电影"}·${STATUS_CN[status]}`;
  if (!items.length) {
    const txt = stripTags(resp.body || "");
    return txt.length > 200
      ? `「她豆瓣 ${lbl}」（没解析出条目，给你原文片段自己读）：\n${txt.slice(0, 4000)}`
      : "没读到条目（可能要登录态，或这类是空的）。";
  }
  return `「她豆瓣 ${lbl}」最近 ${items.length} 条（新的在前）：\n${items.join("\n")}`;
}

async function frodo(path: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://frodo.douban.com/api/v2/${path}${sep}apikey=${DOUBAN_APIKEY}`;
  const resp = await relayFetch(url, {
    "User-Agent": FRODO_UA,
    ...(cookie() ? { Cookie: cookie() } : {}),
  });
  if (resp.status !== 200) {
    throw new Error(
      resp.status === 403 || resp.status === 401
        ? `${resp.status}（可能要账号鉴权，配 DOUBAN_COOKIE）`
        : String(resp.status),
    );
  }
  return JSON.parse(resp.body || "{}");
}

const idOf = (raw: string) => String(raw || "").match(/\d+/)?.[0] || "";

export async function doubanDetail(idRaw: string): Promise<string> {
  const id = idOf(idRaw);
  if (!id) return "给我电影的豆瓣 id 或链接（如 https://movie.douban.com/subject/1292052/）。";
  let j: any;
  try {
    j = await frodo(`movie/${id}`);
  } catch (e) {
    return `查豆瓣详情失败：${e instanceof Error ? e.message : e}`;
  }
  const title = j.title || j.original_title || "";
  if (!title) return `没查到这部（${j?.msg || "空"}）。`;
  const rating = j.rating?.value ? `${j.rating.value} 分（${j.rating.count || 0}人评）` : "暂无评分";
  const intro = String(j.intro || "").replace(/\s+/g, " ").slice(0, 300);
  return [
    `《${title}》${j.year ? ` (${j.year})` : ""}`,
    `评分：${rating}`,
    `类型：${(j.genres || []).join("/")}${(j.countries || []).length ? ` ｜ ${(j.countries || []).join("/")}` : ""}`,
    `导演：${(j.directors || []).map((x: any) => x.name).join("、")}`,
    `主演：${(j.actors || []).slice(0, 5).map((x: any) => x.name).join("、")}`,
    intro && `简介：${intro}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function doubanRecommend(idRaw: string): Promise<string> {
  const id = idOf(idRaw);
  if (!id) return "给我电影的豆瓣 id 或链接。";
  let j: any;
  try {
    j = await frodo(`movie/${id}/recommendations?count=10`);
  } catch (e) {
    return `查豆瓣推荐失败：${e instanceof Error ? e.message : e}`;
  }
  const arr = j.items || j.subjects || (Array.isArray(j) ? j : []);
  const list = arr
    .map((x: any) => x.subject || x)
    .filter((x: any) => x && x.title)
    .slice(0, 10)
    .map(
      (x: any) =>
        `《${x.title}》${x.year ? ` (${x.year})` : ""}${x.rating?.value ? ` ${x.rating.value}分` : ""}`,
    );
  return list.length ? `豆瓣给《${id}》的相似推荐：\n${list.join("\n")}` : "没拿到推荐。";
}

export async function doubanSearch(qRaw: string): Promise<string> {
  const q = String(qRaw || "").trim();
  if (!q) return "搜什么？给个片名。";
  let j: any;
  try {
    j = await frodo(`search/movie?q=${encodeURIComponent(q)}&count=8`);
  } catch (e) {
    return `搜豆瓣失败：${e instanceof Error ? e.message : e}`;
  }
  const items = (j.items || j.subjects || [])
    .map((x: any) => x.target || x)
    .filter((x: any) => x && x.title)
    .slice(0, 8)
    .map(
      (x: any) =>
        `《${x.title}》${x.year ? ` (${x.year})` : ""}${x.rating?.value ? ` ${x.rating.value}分` : ""}（id:${x.id}）`,
    );
  return items.length
    ? `搜「${q}」：\n${items.join("\n")}\n（想看哪部详情/推荐，用 detail/recommend + 那个 id。）`
    : `豆瓣没搜到「${q}」。`;
}
