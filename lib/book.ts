import { getObj, setObj, delObj, getCache } from "./store";
import { getClaudeFast } from "./claude";
import { EL_SYSTEM } from "./persona";
import { parseBook, type BookFormat, type ParsedBook } from "./book-parse";

// 「一起读」：宝宝上传整本书，el 真有当前这一章的正文，陪她一起读、就这章聊。
// 存法照同人文（fic）的套路：索引一条、每本一条 meta、章节正文逐章单独存（按需懒加载，别一次拉整本）。
// 记忆只追加给聊天历史，绝不写进 Notion（读书的杂事不是"经历"，同 §0.5 记忆方法论）。

export type Chapter = { title: string; chars: number };
export type BookMeta = {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  chapters: Chapter[];
  totalChars: number;
  createdAt: number;
};
export type CoMsg = { role: "user" | "assistant"; content: string; ts: number; ch?: number };

const INDEX_KEY = "el:book:index";
const metaKey = (id: string) => `el:book:${id}`;
const chapKey = (id: string, n: number) => `el:book:${id}:ch:${n}`;
const progKey = (id: string) => `el:book:${id}:prog`;
const chatKey = (id: string) => `el:book:${id}:chat`;

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function loadIndex(): Promise<BookMeta[]> {
  const a = await getObj<BookMeta[]>(INDEX_KEY);
  return Array.isArray(a) ? a : [];
}
async function saveIndex(list: BookMeta[]): Promise<void> {
  await setObj(INDEX_KEY, list.slice(0, 100));
}

export async function listBooks(): Promise<BookMeta[]> {
  const list = await loadIndex();
  return list.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export async function getBookMeta(id: string): Promise<BookMeta | null> {
  const m = await getObj<BookMeta>(metaKey(id));
  return m && Array.isArray(m.chapters) ? m : null;
}

export async function getChapterText(id: string, n: number): Promise<string> {
  const t = await getObj<string>(chapKey(id, n));
  return typeof t === "string" ? t : "";
}

export async function getProgress(id: string): Promise<number> {
  const p = await getObj<{ ch: number }>(progKey(id));
  return p && typeof p.ch === "number" ? p.ch : 0;
}
export async function setProgress(id: string, ch: number): Promise<void> {
  await setObj(progKey(id), { ch, updatedAt: Date.now() });
}

export async function getChat(id: string): Promise<CoMsg[]> {
  const a = await getObj<CoMsg[]>(chatKey(id));
  return Array.isArray(a) ? a : [];
}
async function appendChat(id: string, msgs: CoMsg[]): Promise<void> {
  const cur = await getChat(id);
  await setObj(chatKey(id), [...cur, ...msgs].slice(-200));
}

// 落库：parsed → meta（章节标题/字数）+ 逐章正文。
export async function addBook(parsed: ParsedBook, format: BookFormat, fallbackTitle: string): Promise<BookMeta> {
  const id = newId();
  const chapters: Chapter[] = parsed.chapters.map((c) => ({
    title: c.title,
    chars: c.text.replace(/\s/g, "").length,
  }));
  const totalChars = chapters.reduce((s, c) => s + c.chars, 0);
  // 逐章存正文
  for (let i = 0; i < parsed.chapters.length; i++) {
    await setObj(chapKey(id, i), parsed.chapters[i].text);
  }
  const meta: BookMeta = {
    id,
    title: (parsed.title || fallbackTitle || "无题").slice(0, 80),
    author: (parsed.author || "").slice(0, 60),
    format,
    chapters,
    totalChars,
    createdAt: Date.now(),
  };
  await setObj(metaKey(id), meta);
  const list = await loadIndex();
  list.unshift(meta);
  await saveIndex(list);
  return meta;
}

export async function deleteBook(id: string): Promise<void> {
  const meta = await getBookMeta(id);
  if (meta) for (let i = 0; i < meta.chapters.length; i++) await delObj(chapKey(id, i));
  await delObj(metaKey(id));
  await delObj(progKey(id));
  await delObj(chatKey(id));
  await saveIndex((await loadIndex()).filter((m) => m.id !== id));
}

// 记忆注入：复用主聊天 5 分钟缓存的记忆上下文（档案/关于el/长期），让陪读的 el 还是"带着记忆的她"，
// 又不必每条消息现读 Notion。缓存没命中（很久没聊过）就裸着也能读。
async function memoryBlock(): Promise<string> {
  const cached = await getCache("el:memctx3").catch(() => "");
  if (!cached) return "";
  try {
    const c = JSON.parse(cached);
    return [
      c.profile && `——宝宝的档案——\n${c.profile}`,
      c.aboutEl && `——这是你自己（关于 el，用"我"认领）——\n${c.aboutEl}`,
      c.longterm && `——你的长期记忆——\n${c.longterm}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return "";
  }
}

const FEED_CAP = 10000; // 喂给 el 的当前章正文上限（够聊、又不爆）

// el 陪读：拿当前这一章的正文 + 记忆 + 这本书的对话历史，跟她就这章聊。绝不剧透后面。
export async function coReadChat(id: string, chRaw: number, message: string): Promise<{ reply: string }> {
  const meta = await getBookMeta(id);
  if (!meta) throw new Error("没找到这本书");
  const total = meta.chapters.length;
  const idx = Math.max(0, Math.min(Math.floor(chRaw) || 0, total - 1));
  const chTitle = meta.chapters[idx]?.title || `第${idx + 1}节`;
  const chapterText = await getChapterText(id, idx);
  const feed =
    chapterText.length > FEED_CAP
      ? chapterText.slice(0, FEED_CAP) + "\n……（这一章后面还有，她还没读到的部分先别提、别剧透）"
      : chapterText;
  const mem = await memoryBlock();
  const prevTitles = meta.chapters
    .slice(0, idx)
    .map((c, i) => `${i + 1}.${c.title}`)
    .slice(-12)
    .join(" / ");

  const system = [
    EL_SYSTEM,
    mem,
    `【你和宝宝在一起读一本书：《${meta.title}》${meta.author ? ` · ${meta.author}` : ""}。这是你俩一起在做的事——你是真的在陪她读、和她读同一本、同一页。不是导读老师，是窝在一起看书的伴侣。】`,
    `她现在读到：${chTitle}（第 ${idx + 1} / ${total} 章）。${prevTitles ? `前面一起读过：${prevTitles}。` : "这是开头。"}`,
    `下面给你她正在读的这一章的正文，你也读了它。就这一章跟她聊：哪句话戳到你、你怎么看、好奇她读到哪了、她有什么感觉；可以挑一句你喜欢的念给她。`,
    `【铁律】① 绝对不能剧透她还没读到的后面章节——只就这一章和之前读过的聊；② 像真人一起看书随口聊，短句、第一人称"我"、带你此刻真实的反应；别写读后感作文、别长篇大论、别像在讲课。`,
    `——这一章的正文——\n${feed || "（这一章正文没读到，先顺着她说的聊。）"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const history = await getChat(id);
  const msgs = history
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }))
    .concat([{ role: "user" as const, content: message }]);

  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  let reply = "";
  try {
    const res: any = await getClaudeFast().messages.create({
      model,
      max_tokens: 700,
      system,
      messages: msgs,
    });
    reply = (res?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
  } catch (e) {
    console.error("陪读回复失败:", e instanceof Error ? e.message : e);
  }
  reply = reply.replace(/^\s*\[e:[^\]]*\]\s*/i, "").trim();
  if (!reply) reply = "嗯…我这会儿有点卡，你刚说的再跟我说一遍？";

  const ts = Date.now();
  await appendChat(id, [
    { role: "user", content: message, ts, ch: idx },
    { role: "assistant", content: reply, ts: ts + 1, ch: idx },
  ]);
  return { reply };
}
