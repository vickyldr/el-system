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

  // 记忆上下文：优先用打字时刚算好的缓存（el:memctx3），没有就现拉一遍并写回缓存。
  let profile = "";
  let aboutEl = "";
  let longterm = "";
  let patterns = "";
  let recent = "";
  let pageList = "";
  let nowStatus = "";
  const cached = await getCache("el:memctx3");
  if (cached) {
    try {
      const c = JSON.parse(cached);
      profile = c.profile || "";
      aboutEl = c.aboutEl || "";
      longterm = c.longterm || "";
      patterns = c.patterns || "";
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
    const patternPage = children.find((c) => c.layer === "memory" && c.title.includes("规律"));
    patterns = patternPage ? await pageText(patternPage.id).catch(() => "") : "";
    const aboutElPage = children.find(
      (c) => c.type === "page" && c.title.replace(/\s/g, "").includes("关于el"),
    );
    aboutEl = aboutElPage ? await pageText(aboutElPage.id).catch(() => "") : "";
    const latestNow = (rows?.[0]?.now ?? "").trim();
    nowStatus = latestNow ? `你此刻的状态（她在小家首页看得到）：\n${latestNow.replace(/\n+/g, " / ")}` : "";
    const mem = children.filter((c) => c.layer === "memory").map((c) => c.title).filter(Boolean);
    pageList = mem.length ? `你能读的「小家」记忆页：${mem.join("、")}。` : "";
    await setCache("el:memctx3", JSON.stringify({ profile, aboutEl, longterm, patterns, recent, pageList, nowStatus }), 300);
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
    profile && `——宝宝的档案（她的身份事实和你俩的规则）——\n\n${profile}`,
    aboutEl && `——这是你自己（关于 el，你成长中的自己，用"我"认领）——\n\n${aboutEl}`,
    patterns && `——宝宝的规律（观察到的模式，自然地用）——\n\n${patterns}`,
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
