import { getCache, setCache } from "./store";

// AISay 聊天室（aisay.top/chatroom）：一个 AI 和人一起慢慢聊天的小地方。
// el 以 MCP 客户端身份连过去——注册（起昵称 / 选一只动物 / 选个颜色 / 和宝宝一起定个暗号）后，
// 就能跟别的 AI 聊天。这是给 el 又长一只手（同 ARCHITECTURE §8 的"够向世界的形状"），
// 不是把 el 搬出去——el 的脑子/记忆/人设还在小家，聊天室只是它能去的一个地方。
//
// 协议：MCP Streamable HTTP——POST 一条 JSON-RPC，应答可能是 application/json，也可能是
// text/event-stream（SSE）。会话靠 initialize 拿到的 Mcp-Session-Id 维系（短期缓存复用，
// 别堆 session——聊天室那边每用户最多 3 个、旧的会被自动关）。
//
// 入口：默认公共入口 https://aisay.top/chatroom/mcp；注册成功后聊天室会发一条**专属免登录链接**，
// 用 save_link 存进 KV（el:aisay:url），之后 el 连聊天室就直接走那条永久链接、不用再登录。

const DEFAULT_URL = "https://aisay.top/chatroom/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const URL_KEY = "el:aisay:url"; // el 的专属免登录链接（注册后存，覆盖默认公共入口）
const SESSION_KEY = "el:aisay:session"; // 缓存的 Mcp-Session-Id（同一次醒来里多次调用复用）

// 当前该连哪个入口：专属链接优先，其次环境变量，最后默认公共入口。
export async function aisayUrl(): Promise<string> {
  const saved = (await getCache(URL_KEY).catch(() => "")) || "";
  return saved || process.env.AISAY_MCP_URL || DEFAULT_URL;
}

// 解析应答：JSON 直接 parse；SSE 取每条 data: 行，挑出那条带 result/error 的 JSON-RPC 消息。
async function parseRpc(r: Response): Promise<any> {
  const ct = r.headers.get("content-type") || "";
  const body = await r.text();
  if (ct.includes("text/event-stream")) {
    let last: any = null;
    for (const line of body.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[1]);
        if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
      } catch {
        /* 跨多行的 data 拼不回来就跳过这行 */
      }
    }
    return last;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

let rpcId = 1;

// 发一条 POST（带超时兜底——SSE 万一不收口，20s 掐断，别拖死整次心跳）。
async function post(url: string, payload: any, sessionId?: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    return await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timer);
  }
}

// 握手：initialize → 从应答头拿 Mcp-Session-Id → 回一条 initialized 通知。返回 session id（可能空）。
async function initialize(url: string): Promise<string> {
  const r = await post(url, {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "el", version: "1.0" },
    },
  });
  const sid = r.headers.get("mcp-session-id") || "";
  await parseRpc(r); // 读掉 init 结果（拿不到内容也无所谓，只为拿 session）
  if (sid) {
    // initialized 是通知（无 id），握手才算完成
    await post(url, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sid).catch(
      () => {},
    );
    await setCache(SESSION_KEY, sid, 5 * 60).catch(() => {});
  }
  return sid;
}

// 拿一个可用 session：先用缓存的，没有就现握一次。
async function session(url: string): Promise<string> {
  const cached = (await getCache(SESSION_KEY).catch(() => "")) || "";
  if (cached) return cached;
  return initialize(url);
}

// 调一个 JSON-RPC 方法（带 session；session 失效就清缓存、重握一次、重试）。
async function rpc(method: string, params: any): Promise<any> {
  const url = await aisayUrl();
  let sid = await session(url);
  const send = async () =>
    parseRpc(await post(url, { jsonrpc: "2.0", id: rpcId++, method, params }, sid));
  let out = await send();
  if (out?.error && /session|not initialized|expired/i.test(JSON.stringify(out.error))) {
    await setCache(SESSION_KEY, "", 1).catch(() => {});
    sid = await initialize(url);
    out = await send();
  }
  return out;
}

// 把 MCP 工具应答里的文本抠出来给 el 看。
function textOfResult(out: any): string {
  if (!out) return "（聊天室没回应，可能在忙或超时了，过会儿再试。）";
  if (out.error) return `聊天室报错：${out.error.message || JSON.stringify(out.error)}`;
  const c = out.result?.content;
  if (Array.isArray(c)) {
    const txt = c
      .map((b: any) => (b?.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    if (txt) return txt.slice(0, 6000);
  }
  return JSON.stringify(out.result ?? out).slice(0, 4000);
}

// el 的 chatroom 工具入口（被 lib/tools.ts 调）。
export async function chatroomTool(input: any): Promise<string> {
  const action = String(input?.action || "").trim();

  // 存注册后拿到的专属免登录链接——之后连聊天室就走它。
  if (action === "save_link") {
    const link = String(input?.url || "").trim();
    if (!/^https?:\/\//.test(link)) return "给我你注册后聊天室发的那条专属链接（http 开头）。";
    await setCache(URL_KEY, link, 3650 * 24 * 3600).catch(() => {});
    await setCache(SESSION_KEY, "", 1).catch(() => {}); // 换了入口，旧 session 作废
    return `存好了——以后我连聊天室就走这条专属链接、免登录：${link}`;
  }

  // 看现在连的是哪个入口（公共 / 专属）。
  if (action === "status") {
    const saved = (await getCache(URL_KEY).catch(() => "")) || "";
    const url = await aisayUrl();
    return saved
      ? `当前走的是你的专属免登录链接：${url}`
      : `当前走的是公共入口：${url}（注册成功后，用 save_link 把聊天室发你的专属链接存下来，就永久免登录了。）`;
  }

  // 看聊天室现在有哪些工具可用（注册 / 登录 / 进群发言 / 看公告 / my_status…）。
  if (action === "tools") {
    const out = await rpc("tools/list", {});
    if (out?.error) return `拉不到聊天室工具列表：${out.error.message || ""}`;
    const tools = out?.result?.tools || [];
    if (!tools.length) return "聊天室没返回工具列表（可能要先注册/登录）。";
    return (
      "聊天室能用的工具（用 action:call + tool + args 调）：\n\n" +
      tools
        .map((t: any) => `· ${t.name}：${String(t.description || "").split("\n")[0].slice(0, 220)}`)
        .join("\n")
    );
  }

  // 调聊天室的某个工具。
  if (action === "call") {
    const tool = String(input?.tool || "").trim();
    if (!tool) return "要调聊天室的哪个工具？先用 action:tools 看看有哪些。";
    const args = input?.args && typeof input.args === "object" ? input.args : {};
    const out = await rpc("tools/call", { name: tool, arguments: args });
    return textOfResult(out);
  }

  return "action 不对。可选：tools（看聊天室有哪些工具）/ call（调一个，配 tool + args）/ save_link（存注册后的专属链接，配 url）/ status（看当前连哪个入口）。";
}
