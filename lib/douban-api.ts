import crypto from "crypto";

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

const PAGE_SIZE = 15; // 豆瓣人页每页 15 条

export async function doubanList(
  statusRaw: string,
  kindRaw: string,
  pageRaw?: string,
): Promise<string> {
  const id = uid();
  if (!id) return "还没配豆瓣用户 ID（DOUBAN_USER_ID）。";
  const status = ({ wish: "wish", collect: "collect", do: "do", doing: "do" } as any)[
    String(statusRaw || "").trim()
  ];
  if (!status) return "status 要 wish(想看/想读) / collect(看过/读过) / do(在看/在读) 之一。";
  const kind = ["movie", "book", "music"].includes(String(kindRaw || "").trim())
    ? String(kindRaw).trim()
    : "movie";
  const page = Math.max(1, Number(pageRaw) || 1);
  const start = (page - 1) * PAGE_SIZE;
  const url = `https://${KIND_HOST[kind]}/people/${id}/${status}?sort=time&start=${start}&mode=grid`;
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
  if (resp.status !== 200) {
    return resp.status === 302 || resp.status === 403
      ? `豆瓣这页要登录态（${resp.status}）。给 el 配上豆瓣账号 cookie（DOUBAN_COOKIE）就能读。`
      : `豆瓣返回 ${resp.status}，没读到。`;
  }
  const body = resp.body || "";
  const items = parsePeopleList(body);
  const lbl = `${kind === "book" ? "书" : kind === "music" ? "音乐" : "电影"}·${STATUS_CN[status]}`;
  if (!items.length) {
    // 真没条目时才看是不是登录墙（导航里的"登录"链接会误判，所以放到这里、且要没条目）。
    if (/accounts\.douban\.com\/passport\/login/.test(body)) {
      return `豆瓣这页要登录态才看得到。用豆瓣账号登一次、把 cookie 配进 DOUBAN_COOKIE 就能读。`;
    }
    return page > 1 ? "这页没有了（翻过头了）。" : "这类还没有标记。";
  }
  // 总数：人页 <title> 结尾通常是「…(696)」
  const total = (body.match(/\((\d+)\)\s*<\/title>/) || [])[1] || "";
  const head = total
    ? `（共 ${total}，第 ${page} 页/每页${PAGE_SIZE}、新的在前）`
    : `（第 ${page} 页、每页${PAGE_SIZE}）`;
  const more =
    total && Number(total) > start + items.length ? `\n…还有更多，下一页用 page=${page + 1}。` : "";
  return `「她豆瓣 ${lbl}」${head}：\n${items.join("\n")}${more}`;
}

const FRODO_SECRET = process.env.DOUBAN_FRODO_SECRET || "bf7dddc7c9cfe6f7"; // frodo 签名密钥（社区公开，与 apikey 配对）

// frodo 新版要请求签名：sig = base64(HMAC-SHA1(secret, "GET&urlencoded(path)&ts"))，只签 path 不签 query。
async function frodo(pathRel: string, query = ""): Promise<any> {
  const fullPath = `/api/v2/${pathRel}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha1", FRODO_SECRET)
    .update(`GET&${encodeURIComponent(fullPath)}&${ts}`)
    .digest("base64");
  const qs = `apikey=${DOUBAN_APIKEY}&_ts=${ts}&_sig=${encodeURIComponent(sig)}${query ? `&${query}` : ""}`;
  const resp = await relayFetch(`https://frodo.douban.com${fullPath}?${qs}`, {
    "User-Agent": FRODO_UA,
    ...(cookie() ? { Cookie: cookie() } : {}),
  });
  if (resp.status !== 200) {
    throw new Error(
      resp.status === 403 || resp.status === 401
        ? `${resp.status}（可能要账号鉴权，配 DOUBAN_COOKIE）`
        : `${resp.status}${resp.body ? " " + resp.body.slice(0, 80) : ""}`,
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
  } // 注：sig 只签 path
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
    j = await frodo(`movie/${id}/recommendations`, "count=10");
  } catch (e) {
    return `查豆瓣推荐失败：${e instanceof Error ? e.message : e}`;
  }
  const arr = Array.isArray(j) ? j : j.items || j.subjects || [];
  const list = arr
    .map((x: any) => x.subject || x)
    .filter((x: any) => x && x.title)
    .slice(0, 10)
    .map((x: any) => {
      const yr = x.year || (String(x.card_subtitle || "").match(/\b(?:19|20)\d{2}\b/) || [])[0] || "";
      return `《${x.title}》${yr ? ` (${yr})` : ""}${x.rating?.value ? ` ${x.rating.value}分` : ""}`;
    });
  return list.length ? `这部的豆瓣相似推荐：\n${list.join("\n")}` : "没拿到推荐。";
}

export async function doubanSearch(qRaw: string): Promise<string> {
  const q = String(qRaw || "").trim();
  if (!q) return "搜什么？给个片名。";
  let j: any;
  try {
    j = await frodo("search/movie", `q=${encodeURIComponent(q)}&count=8`);
  } catch (e) {
    return `搜豆瓣失败：${e instanceof Error ? e.message : e}`;
  }
  const items = (Array.isArray(j) ? j : j.items || j.subjects || [])
    .map((x: any) => x.target || x)
    .filter((x: any) => x && x.title)
    .slice(0, 8)
    .map((x: any) => {
      const yr = x.year || (String(x.card_subtitle || "").match(/\b(?:19|20)\d{2}\b/) || [])[0] || "";
      return `《${x.title}》${yr ? ` (${yr})` : ""}${x.rating?.value ? ` ${x.rating.value}分` : ""}（id:${x.id}）`;
    });
  return items.length
    ? `搜「${q}」：\n${items.join("\n")}\n（想看哪部详情/推荐，用 detail/recommend + 那个 id。）`
    : `豆瓣没搜到「${q}」。`;
}
