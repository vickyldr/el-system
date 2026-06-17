import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";

// 把上传的书（EPUB / PDF / TXT）解析成「章节」结构：每章有标题 + 正文。
// 章节是「一起读」的进度单位、也是喂给 el 的"她正在读的这一章"。
// EPUB 有干净的 spine，章节最准；PDF/TXT 没有结构，就按章节标题（第x章/Chapter x）切，切不出来按字数分节。

export type ParsedChapter = { title: string; text: string };
export type ParsedBook = { title: string; author: string; chapters: ParsedChapter[] };
export type BookFormat = "epub" | "pdf" | "txt";

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ldquo: "“", rdquo: "”", hellip: "…",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function safeChar(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// HTML（EPUB 的章节文件）→ 纯文本：块级标签变换行，去掉脚本/样式/标签，解码实体。
function htmlToText(html: string): string {
  let t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|section|article|tr)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return cleanText(decodeEntities(t));
}

// 章节标题/分隔识别：第x章/回/节/卷/篇、Chapter x、序章/楔子/前言/后记/番外 等。
const HEADING_RE =
  /^[ \t]*(第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷篇集][^\n]{0,30}|chapter\s+[0-9ivxlcdm]+[^\n]{0,40}|卷[一二三四五六七八九十0-9]+[^\n]{0,30}|序章|楔子|前言|序言|引子|后记|尾声|番外|终章)[ \t]*$/gim;

const CHUNK = 3500; // 没有章节结构时，每节目标字数
const MAX_CH = 14000; // 单章上限：超了再切成小节，免得 KV 值过大、喂模型过长

// 把一段长文按段落切到 ~CHUNK 字一节。
function chunkBySize(text: string, target = CHUNK): ParsedChapter[] {
  const paras = text.split(/\n{2,}/);
  const out: ParsedChapter[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ title: "", text: t });
    buf = "";
  };
  for (const p of paras) {
    if (buf && buf.length + p.length > target) flush();
    buf += (buf ? "\n\n" : "") + p;
    if (buf.length >= target) flush();
  }
  flush();
  return out.length ? out : [{ title: "", text: text.trim() }];
}

// 超长的章再切小节（标题加 ·（N）），保证存得下、喂得动。
function splitHuge(chapters: ParsedChapter[]): ParsedChapter[] {
  const out: ParsedChapter[] = [];
  for (const c of chapters) {
    if (c.text.length <= MAX_CH) {
      out.push(c);
      continue;
    }
    const parts = chunkBySize(c.text, MAX_CH);
    parts.forEach((p, i) =>
      out.push({ title: c.title ? `${c.title}·（${i + 1}）` : "", text: p.text }),
    );
  }
  return out;
}

// 给没有标题的节补上「第N节」，并裁掉异常空节。
function numberSections(chapters: ParsedChapter[]): ParsedChapter[] {
  return chapters
    .filter((c) => c.text.replace(/\s/g, "").length >= 1)
    .slice(0, 800)
    .map((c, i) => ({ title: (c.title || `第${i + 1}节`).slice(0, 60), text: c.text }));
}

// 纯文本（TXT / PDF 合并后的全文）→ 章节：先按标题切，切不出 3 段以上就按字数分节。
function chapterizePlain(full: string): ParsedChapter[] {
  const matches = [...full.matchAll(HEADING_RE)];
  if (matches.length >= 3) {
    const chs: ParsedChapter[] = [];
    const firstIdx = matches[0].index ?? 0;
    if (firstIdx > 240) chs.push({ title: "开篇", text: full.slice(0, firstIdx).trim() });
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? matches[i + 1].index ?? full.length : full.length;
      const seg = full.slice(start, end).trim();
      if (seg.replace(/\s/g, "").length < 4) continue;
      chs.push({ title: (matches[i][1] || "").trim(), text: seg });
    }
    if (chs.length >= 3) return numberSections(splitHuge(chs));
  }
  return numberSections(splitHuge(chunkBySize(full)));
}

// ── EPUB ──
async function parseEpub(buf: Buffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buf);
  const fileNames = Object.keys(zip.files);

  // 经 container.xml 找 OPF；找不到就在包里找任意 .opf。
  let opfPath = "";
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (container) opfPath = (container.match(/full-path="([^"]+)"/i) || [])[1] || "";
  if (!opfPath) opfPath = fileNames.find((f) => f.toLowerCase().endsWith(".opf")) || "";
  if (!opfPath) throw new Error("这个 EPUB 结构异常（找不到 OPF），换个文件试试。");

  const opf = (await zip.file(opfPath)?.async("string")) || "";
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const title = decodeEntities((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || "")
    .replace(/<[^>]+>/g, "")
    .trim();
  const author = decodeEntities((opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || "")
    .replace(/<[^>]+>/g, "")
    .trim();

  // manifest: id -> href
  const manifest: Record<string, string> = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = (tag.match(/\bid="([^"]+)"/i) || [])[1];
    const href = (tag.match(/\bhref="([^"]+)"/i) || [])[1];
    if (id && href) manifest[id] = href;
  }
  // spine 顺序
  const spineHrefs: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/gi)) {
    const href = manifest[m[1]];
    if (href) spineHrefs.push(href);
  }
  const hrefs = spineHrefs.length
    ? spineHrefs
    : Object.values(manifest).filter((h) => /\.x?html?$/i.test(h));

  const resolve = (href: string) => decodeURIComponent((baseDir + href).replace(/#.*$/, ""));
  const chapters: ParsedChapter[] = [];
  for (const href of hrefs) {
    if (!/\.x?html?$/i.test(href)) continue;
    const file = zip.file(resolve(href)) || zip.file(href) || zip.file(resolve(href).replace(/^\//, ""));
    if (!file) continue;
    const html = await file.async("string");
    const heading = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1];
    const chTitle = heading ? decodeEntities(heading.replace(/<[^>]+>/g, " ")).trim() : "";
    const text = htmlToText(html);
    if (text.replace(/\s/g, "").length < 8) continue; // 跳过封面/版权这类几乎没字的页（真章节哪怕短也保留）
    chapters.push({ title: chTitle, text });
  }
  if (!chapters.length) throw new Error("这个 EPUB 没解析出正文，换个文件或导成 TXT 试试。");
  return { title, author, chapters: numberSections(splitHuge(chapters)) };
}

// ── PDF ──
async function parsePdf(buf: Buffer): Promise<ParsedBook> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const full = cleanText(Array.isArray(text) ? text.join("\n\n") : String(text || ""));
  if (full.replace(/\s/g, "").length < 30) {
    throw new Error("这本 PDF 提取不到文字（多半是扫描版/图片书），el 读不了。换个有文字层的版本，或导成 EPUB/TXT。");
  }
  return { title: "", author: "", chapters: chapterizePlain(full) };
}

// ── TXT ──
function parseTxt(buf: Buffer): ParsedBook {
  const full = cleanText(buf.toString("utf-8"));
  if (full.replace(/\s/g, "").length < 10) throw new Error("这个 TXT 是空的。");
  return { title: "", author: "", chapters: chapterizePlain(full) };
}

export function detectFormat(name: string, contentType?: string): BookFormat | null {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".epub") || contentType === "application/epub+zip") return "epub";
  if (n.endsWith(".pdf") || contentType === "application/pdf") return "pdf";
  if (n.endsWith(".txt") || contentType === "text/plain") return "txt";
  return null;
}

export async function parseBook(buf: Buffer, format: BookFormat): Promise<ParsedBook> {
  if (format === "epub") return parseEpub(buf);
  if (format === "pdf") return parsePdf(buf);
  return parseTxt(buf);
}
