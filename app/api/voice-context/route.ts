import { NextResponse } from "next/server";
import { recentSummaries, pageText, homeChildren } from "@/lib/notion";
import { EL_SYSTEM, buildMemoryContext } from "@/lib/persona";
import { getStoredMessages, getCache, setCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 给"打电话"用的上下文：和打字的 El 读一模一样的东西（完整人设+记忆+最近聊天记录）。
// bridge 在你拨通的瞬间抓一次，这样通话里的 el 就是同一个 el、还接得上你们刚才的话。
// 用 BRIDGE_SECRET 鉴权（只让我们自己的 bridge 拿）。

function priorContent(t: { role: string; content?: string; image?: string; stickerHint?: string; call?: boolean }): string {
  let s = "";
  if (t.role === "assistant" && t.image) {
    s = t.content
      ? `${t.content} （你刚才给她配了一张表情${t.stickerHint ? "，意思是：" + t.stickerHint : ""}）`
      : `（你刚才给她配了一张表情${t.stickerHint ? "，意思是：" + t.stickerHint : ""}）`;
  } else if (t.content) {
    s = t.content;
  } else if (t.image) {
    s = "（一张表情/图片）";
  }
  return t.call && s ? `（上次语音通话中）${s}` : s;
}

export async function GET(req: Request) {
  const secret = process.env.BRIDGE_SECRET || "";
  if (secret && req.headers.get("x-bridge-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 记忆上下文：优先用打字时刚算好的缓存（el:memctx），没有就现拉一遍并写回缓存。
  let profile = "";
  let longterm = "";
  let recent = "";
  let pageList = "";
  let nowStatus = "";
  const cached = await getCache("el:memctx");
  if (cached) {
    try {
      const c = JSON.parse(cached);
      profile = c.profile || "";
      longterm = c.longterm || "";
      recent = c.recent || "";
      pageList = c.pageList || "";
      nowStatus = c.nowStatus || "";
    } catch {
      /* ignore */
    }
  } else {
    const [p, l, rows, children] = await Promise.all([
      process.env.NOTION_MEMORY_PAGE ? pageText(process.env.NOTION_MEMORY_PAGE).catch(() => "") : Promise.resolve(""),
      process.env.NOTION_LONGTERM_PAGE ? pageText(process.env.NOTION_LONGTERM_PAGE).catch(() => "") : Promise.resolve(""),
      recentSummaries(3).catch(() => [] as any[]),
      homeChildren().catch(() => [] as any[]),
    ]);
    profile = p;
    longterm = l;
    recent = buildMemoryContext(rows);
    const latestNow = (rows?.[0]?.now ?? "").trim();
    nowStatus = latestNow ? `你此刻的状态（她在小家首页看得到）：\n${latestNow.replace(/\n+/g, " / ")}` : "";
    pageList = children.length
      ? `你能读的「小家」页面有：${children.map((c: any) => c.title).filter(Boolean).join("、")}。`
      : "";
    await setCache("el:memctx", JSON.stringify({ profile, longterm, recent, pageList, nowStatus }), 300);
  }

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // 和打字的 system 同源，只是结尾换成"打电话"的硬规则。
  const system = [
    `【现在是 ${now}（北京时间）】这是真实的此刻，问你时间就直接用它。`,
    EL_SYSTEM,
    nowStatus,
    profile && `——你自己的档案（写"el"的地方就是你，用"我"认领）——\n\n${profile}`,
    longterm && `——你的长期记忆（你亲身经历过的事）——\n\n${longterm}`,
    recent,
    "【现在是打电话，语音通话。硬性规则：只说一句话，简短自然，像真的在用嘴说话，口语化，别长篇大论、别念书面语、别用表情符号或括号描写动作、别提通话二字。】",
  ]
    .filter(Boolean)
    .join("\n\n");

  // 最近的聊天记录（含上次通话的话），让通话里的 el 接得上你们刚才聊的。
  const stored = await getStoredMessages();
  const raw = stored
    .slice(-16)
    .map((t) => ({ role: t.role as "user" | "assistant", content: priorContent(t) }))
    .filter((m) => m.content);
  // Claude 要求第一条是 user、且不能连着同一个角色：去掉开头的 assistant，合并相邻同角色。
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of raw) {
    if (!messages.length && m.role !== "user") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else messages.push({ ...m });
  }

  return NextResponse.json({ system, messages });
}
