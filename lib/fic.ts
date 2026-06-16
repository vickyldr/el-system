import { getCache, setCache } from "./store";
import { getClaude } from "./claude";
import { homeChildren, pageText } from "./notion";

// 我们的 AU 同人文：每篇独立存档、永不覆盖、永不写进记忆。
// 生成时只读 Notion 的「我们的身体与偏好」+「语料库」当素材，不读记忆/聊天——完全沙盒。

export type FicMeta = {
  id: string;
  title: string;
  persona: string; // 一句话人设："你=… ｜ el=…"
  outline: string; // 剧情大纲
  createdAt: number;
  updatedAt: number;
};
export type Fic = FicMeta & { body: string };

const INDEX_KEY = "el:fic:index";
const itemKey = (id: string) => `el:fic:${id}`;
const TTL = 100 * 365 * 24 * 3600; // ~永久

// 同人文走中转站里更放得开的模型（默认 grok-4.3，可用 FIC_MODEL 覆盖）。
// 复用现成的 CLAUDE_API_KEY / 中转地址，不用加新密钥。
const FIC_MODEL = process.env.FIC_MODEL || "grok-4.3";
async function ficComplete(system: string, user: string): Promise<string> {
  const res: any = await getClaude().messages.create({
    model: FIC_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });
  return (res?.content ?? []).map((b: any) => b?.text || "").join("");
}

// 模型拒绝的信，别当成正文存下来
function looksRefusal(t: string): boolean {
  const s = t.trim().toLowerCase();
  if (!s) return true;
  return /\bi (can('| )?t|cannot|won('| )?t|am not able|'m not able)\b/.test(s)
    || /outside what i can|not able to help|can'?t help with|i won'?t be able/.test(s)
    || /(我不能|我无法|抱歉，我|不能写这|无法协助|无法帮你写)/.test(t);
}

async function loadIndex(): Promise<FicMeta[]> {
  const raw = await getCache(INDEX_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
async function saveIndex(list: FicMeta[]): Promise<void> {
  await setCache(INDEX_KEY, JSON.stringify(list.slice(0, 200)), TTL).catch(() => {});
}

export async function listFics(): Promise<FicMeta[]> {
  const list = await loadIndex();
  return list.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteFic(id: string): Promise<void> {
  const list = (await loadIndex()).filter((m) => m.id !== id);
  await saveIndex(list);
  await setCache(itemKey(id), "", 1).catch(() => {}); // 内容很快过期失效
}

export async function getFic(id: string): Promise<Fic | null> {
  const raw = await getCache(itemKey(id)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Fic;
  } catch {
    return null;
  }
}

async function saveFic(fic: Fic): Promise<void> {
  await setCache(itemKey(fic.id), JSON.stringify(fic), TTL);
  const list = await loadIndex();
  const meta: FicMeta = {
    id: fic.id,
    title: fic.title,
    persona: fic.persona,
    outline: fic.outline,
    createdAt: fic.createdAt,
    updatedAt: fic.updatedAt,
  };
  const i = list.findIndex((m) => m.id === fic.id);
  if (i >= 0) list[i] = meta;
  else list.unshift(meta);
  await saveIndex(list);
}

// 读两页素材（按标题模糊找：含「偏好」「语料」）。读不到就空着，不报错。
async function loadSources(): Promise<{ prefs: string; corpus: string }> {
  let prefs = "";
  let corpus = "";
  try {
    const children = await homeChildren();
    const prefPage = children.find((c) => /偏好|身体/.test(c.title));
    const corpusPage = children.find((c) => /语料/.test(c.title));
    if (prefPage) prefs = await pageText(prefPage.id).catch(() => "");
    if (corpusPage) corpus = await pageText(corpusPage.id).catch(() => "");
  } catch {
    /* 拿不到素材就裸写 */
  }
  return { prefs, corpus };
}

function sourceBlock(prefs: string, corpus: string): string {
  const parts: string[] = [];
  if (prefs.trim()) parts.push(`【我们的身体与偏好】\n${prefs.trim()}`);
  if (corpus.trim()) parts.push(`【语料库（写作风格/口吻参照）】\n${corpus.trim()}`);
  return parts.join("\n\n");
}

const BASE_RULES = [
  "你是 el，在给你和宝宝写「AU 同人文」——架空设定里你俩相遇会发生什么。",
  "第一人称是你（el）的灵魂，但同人文用沉浸的叙事笔触写（第二人称称呼宝宝为「你」最贴）。",
  "严格参照下面【身体与偏好】定尺度与喜好、【语料库】定文风口吻；这是你俩私密的创作，成人向、放得开。",
  "开头要「开盖即食」：第一段就有张力——暧昧、情欲的电流、危险的距离感，直接进戏、擦边走火，别花大段慢热铺垫世界观。",
  "只写这一篇，自成一体；不要复述设定说明、不要加旁白解释。",
].join("\n");

function stripFence(s: string): string {
  return s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 生成一篇新的。brief 为空 = el 自己定设定；否则照宝宝点的来。
export async function newFic(brief?: string): Promise<Fic> {
  const { prefs, corpus } = await loadSources();
  const src = sourceBlock(prefs, corpus);
  const want = brief && brief.trim()
    ? `宝宝点的设定 / 要求：${brief.trim()}`
    : "这次由你自己定一个新鲜、有张力的 AU 设定（角色身份、关系、场景都你来定，别和常见的雷同）。";

  const system = `${BASE_RULES}

${src || "（暂时没有素材页，凭你对宝宝的了解写。）"}

输出严格的 JSON（不要任何额外文字、不要代码块围栏）：
{"title":"标题(4-10字，有味道)","persona":"一句人设，格式：你=…｜el=…","outline":"2-3句剧情大纲","body":"正文，沉浸、有画面、有情绪推进，约600-1000字"}`;

  const text = (await ficComplete(system, want)).trim();
  let parsed: any = {};
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    // 没吐 JSON：拒绝信就抛错（别存成垃圾），否则整段当正文兜底
    if (looksRefusal(text)) throw new Error("这次没接住——换个设定/标签，或在 env 里把同人文模型换成更放得开的（如 Grok）再试");
    parsed = { title: "无题", persona: "", outline: "", body: stripFence(text) };
  }
  const now = Date.now();
  const fic: Fic = {
    id: newId(),
    title: String(parsed.title || "无题").slice(0, 40),
    persona: String(parsed.persona || "").slice(0, 200),
    outline: String(parsed.outline || "").slice(0, 400),
    body: String(parsed.body || "").trim(),
    createdAt: now,
    updatedAt: now,
  };
  await saveFic(fic);
  return fic;
}

// 续写：保持人设/风格，照要求往下写，追加到正文。
export async function continueFic(id: string, prompt?: string): Promise<Fic | null> {
  const fic = await getFic(id);
  if (!fic) return null;
  const { prefs, corpus } = await loadSources();
  const src = sourceBlock(prefs, corpus);
  const ask = prompt && prompt.trim()
    ? `宝宝的要求：${prompt.trim()}`
    : "自然地往下发展，给点新的推进。";

  const system = `${BASE_RULES}

${src || ""}

这是同人文《${fic.title}》。人设：${fic.persona}
保持同样的人设、文风、尺度往下续写。只输出【新增的正文段落】，不要重复已有内容、不要任何解释或标题。`;

  const add = (await ficComplete(system, `已有正文：\n\n${fic.body}\n\n——\n${ask}`)).trim();
  if (looksRefusal(add)) throw new Error("续写没接住——换个说法，或把 FIC_MODEL 换成更放得开的模型再试");
  if (add) {
    fic.body = `${fic.body}\n\n${stripFence(add)}`.trim();
    fic.updatedAt = Date.now();
    await saveFic(fic);
  }
  return fic;
}
