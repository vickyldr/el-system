import crypto from "crypto";
import { getCache, setCache } from "./store";

// 网易云 weapi 加密（公开常量，社区通用）。把请求参数加密成 params + encSecKey。
const PRESET_KEY = "0CoJUm6Qyw8W8jud";
const IV = "0102030405060708";
const PUBKEY = "010001";
const MODULUS =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";

const COOKIE_KEY = "el:netease:cookie";
const UID_KEY = "el:netease:uid";

// 网易云会拦截非中国 IP（机房 IP）的请求（"460 网络繁忙"）。伪装一个中国 IP 放行。可用 NETEASE_REALIP 改。
const REAL_IP = process.env.NETEASE_REALIP || "116.25.146.177";

function aesEncrypt(text: string, key: string): string {
  const c = crypto.createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64");
}
function rsaEncrypt(text: string): string {
  const reversed = text.split("").reverse().join("");
  const hex = Buffer.from(reversed, "utf8").toString("hex");
  let base = BigInt("0x" + (hex || "0"));
  const exp = BigInt("0x" + PUBKEY);
  const mod = BigInt("0x" + MODULUS);
  let r = 1n;
  base %= mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * base) % mod;
    e >>= 1n;
    base = (base * base) % mod;
  }
  return r.toString(16).padStart(256, "0");
}
function weapi(obj: any) {
  const text = JSON.stringify(obj);
  const secKey = crypto.randomBytes(8).toString("hex"); // 16 字符
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), secKey);
  const encSecKey = rsaEncrypt(secKey);
  return { params, encSecKey };
}

// 带 cookie 的认证请求偶发 -462（风控时灵时不灵），自动重试几次大多能过。
async function weapiPost(
  path: string,
  data: any,
  cookie?: string,
  ipOverride?: string,
): Promise<{ json: any; setCookie: string[] }> {
  let last = { json: {} as any, setCookie: [] as string[] };
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await weapiPostOnce(path, data, cookie, ipOverride);
    if (last.json?.code === -462 && attempt < 3) {
      await new Promise((s) => setTimeout(s, 500 * (attempt + 1)));
      continue;
    }
    return last;
  }
  return last;
}

async function weapiPostOnce(
  path: string,
  data: any,
  cookie?: string,
  ipOverride?: string,
): Promise<{ json: any; setCookie: string[] }> {
  const ip = ipOverride || REAL_IP;
  const enc = weapi({ ...data, csrf_token: "" });
  const form = `params=${encodeURIComponent(enc.params)}&encSecKey=${encodeURIComponent(enc.encSecKey)}`;

  // 配了中国中转(NETEASE_RELAY)就走它——让网易云看到的是真·中国 IP，绕过 -462 风控。
  const relay = process.env.NETEASE_RELAY;
  if (relay) {
    try {
      const rr = await fetch(relay.replace(/\/$/, ""), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Secret": process.env.NETEASE_RELAY_SECRET || "",
        },
        body: JSON.stringify({ path, form, cookie: cookie || "os=pc" }),
      });
      const d = await rr.json().catch(() => ({}));
      return { json: d.json || {}, setCookie: d.setCookie || [] };
    } catch {
      /* 中转挂了就退回直连 */
    }
  }

  const r = await fetch(`https://music.163.com/weapi/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://music.163.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "X-Real-IP": ip,
      "X-Forwarded-For": ip,
      Cookie: cookie || "os=pc",
    },
    body: form,
  });
  const h: any = r.headers;
  const setCookie: string[] = typeof h.getSetCookie === "function"
    ? h.getSetCookie()
    : h.get("set-cookie")
      ? [h.get("set-cookie")]
      : [];
  const json = await r.json().catch(() => ({}));
  return { json, setCookie };
}

// 用 cookie 取账号（uid + 昵称），并存下 uid。account/get 走 weapiPost（已带 -462 重试）。
async function fetchAccount(cookie: string): Promise<{ uid: string; name?: string }> {
  const { json } = await weapiPost("w/nuser/account/get", {}, cookie);
  const uid = json?.account?.id || json?.profile?.userId;
  const name = json?.profile?.nickname;
  if (uid) {
    await setCache(UID_KEY, String(uid), 60 * 24 * 3600).catch(() => {});
    return { uid: String(uid), name };
  }
  return { uid: "" };
}

async function cookieAndUid() {
  const cookie = (await getCache(COOKIE_KEY).catch(() => "")) || "";
  let uid = String((await getCache(UID_KEY).catch(() => "")) || "");
  // cookie 在但 uid 丢了：现取一次（自愈），别误报"没登录"。
  if (cookie && !uid) {
    uid = (await fetchAccount(cookie).catch(() => ({ uid: "" }))).uid;
  }
  return { cookie, uid };
}

// ── 扫码登录 ──
export async function qrKey(ip?: string): Promise<{ unikey: string; code?: number; message?: string }> {
  const { json } = await weapiPost("login/qrcode/unikey", { type: 1 }, undefined, ip);
  return { unikey: json?.unikey || "", code: json?.code, message: json?.message };
}
export function qrImageUrl(unikey: string): string {
  const target = `https://music.163.com/login?codekey=${unikey}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=${encodeURIComponent(target)}`;
}
// code: 800 过期 / 801 等待扫码 / 802 已扫待确认 / 803 成功
export async function qrCheck(unikey: string, ip?: string): Promise<{ code: number; message?: string }> {
  const { json, setCookie } = await weapiPost("login/qrcode/client/login", { key: unikey, type: 1 }, undefined, ip);
  const code = Number(json?.code);
  if (code === 803) {
    const cookie = (setCookie || [])
      .map((c) => c.split(";")[0])
      .filter((c) => /MUSIC_U|__csrf|NMTID/.test(c))
      .join("; ");
    if (cookie) {
      await setCache(COOKIE_KEY, cookie, 60 * 24 * 3600).catch(() => {});
      try {
        const acc = await weapiPost("w/nuser/account/get", {}, cookie);
        const uid = acc.json?.account?.id || acc.json?.profile?.userId;
        if (uid) await setCache(UID_KEY, String(uid), 60 * 24 * 3600).catch(() => {});
      } catch {
        /* uid 拿不到不致命 */
      }
    }
  }
  return { code, message: json?.message };
}
export async function neteaseLoggedIn(): Promise<boolean> {
  const { cookie } = await cookieAndUid();
  return !!cookie;
}

// 手动粘 cookie（你在自己浏览器登好，把 MUSIC_U 复制进来）。存下并验证能不能读到账号。
export async function setNeteaseCookie(
  cookie: string,
): Promise<{ ok: boolean; uid?: string; name?: string; error?: string }> {
  await setCache(COOKIE_KEY, cookie, 60 * 24 * 3600).catch(() => {});
  try {
    const acc = await fetchAccount(cookie);
    if (acc.uid) return { ok: true, uid: acc.uid, name: acc.name };
    return { ok: false, error: "没读到账号信息（风控了，多试一两次）" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── 数据 ──
export async function neteaseSearch(q: string): Promise<string> {
  if (!q.trim()) return "搜什么歌？";
  const { json } = await weapiPost("cloudsearch/get/web", { s: q, type: 1, limit: 8, offset: 0 });
  const songs = json?.result?.songs || [];
  if (!songs.length) return `网易云没搜到「${q}」。`;
  return songs
    .slice(0, 8)
    .map((s: any) => `${s.name} — ${(s.ar || []).map((a: any) => a.name).join("/")}（id:${s.id}）`)
    .join("\n");
}

export async function myPlaylists(): Promise<string> {
  const { cookie, uid } = await cookieAndUid();
  if (!cookie || !uid) return "还没登录网易云——让宝宝去 /netease-login 扫码登一次。";
  const { json } = await weapiPost("user/playlist", { uid, limit: 50, offset: 0, includeVideo: false }, cookie);
  const pls = json?.playlist || [];
  if (!pls.length) return "没读到歌单（登录态可能过期了，让宝宝重新扫一次）。";
  return pls.map((p: any) => `${p.name}（${p.trackCount}首，id:${p.id}）`).join("\n");
}

export async function playlistSongs(id: string): Promise<string> {
  if (!id.trim()) return "要看哪个歌单？给我 id（先用 my_playlists 拿 id）。";
  const { cookie } = await cookieAndUid();
  const { json } = await weapiPost("v3/playlist/detail", { id, n: 1000, s: 8 }, cookie || undefined);
  const pl = json?.playlist;
  if (!pl) return "没读到这个歌单。";
  const tracks = (pl.tracks || [])
    .slice(0, 50)
    .map((t: any) => `${t.name} — ${(t.ar || []).map((a: any) => a.name).join("/")}`);
  return `「${pl.name}」（共${pl.trackCount}首）：\n${tracks.join("\n")}${pl.trackCount > 50 ? "\n…（只列了前50首）" : ""}`;
}

export async function myRecord(allTime = false): Promise<string> {
  const { cookie, uid } = await cookieAndUid();
  if (!cookie || !uid) return "还没登录网易云——让宝宝去 /netease-login 扫码登一次。";
  const { json } = await weapiPost("v1/play/record", { uid, type: allTime ? 0 : 1 }, cookie);
  const data = (allTime ? json?.allData : json?.weekData) || json?.weekData || json?.allData || [];
  if (!data.length) return "没读到听歌记录（她可能设了听歌排行不公开）。";
  return data
    .slice(0, 20)
    .map(
      (x: any) =>
        `${x.song?.name} — ${(x.song?.ar || []).map((a: any) => a.name).join("/")}（播放${x.playCount}次）`,
    )
    .join("\n");
}

export async function recommendSongs(): Promise<string> {
  const { cookie } = await cookieAndUid();
  if (!cookie) return "还没登录网易云——让宝宝去 /netease-login 扫码登一次。";
  const { json } = await weapiPost("v3/discovery/recommend/songs", {}, cookie);
  const songs = json?.data?.dailySongs || [];
  if (!songs.length) return "没拿到每日推荐。";
  return songs
    .slice(0, 15)
    .map((s: any) => `${s.name} — ${(s.ar || []).map((a: any) => a.name).join("/")}`)
    .join("\n");
}
