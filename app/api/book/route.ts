import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import {
  listBooks,
  getBookMeta,
  getChapterText,
  getProgress,
  setProgress,
  getChat,
  addBook,
  deleteBook,
  coReadChat,
} from "@/lib/book";
import { parseBook, detectFormat } from "@/lib/book-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // 解析整本书 + 陪读那轮可能慢，放宽时限

// GET                 → 书架列表（最新在前）
// GET ?id=xxx         → 某本：meta + 进度 + 陪读对话
// GET ?id=xxx&ch=N    → 某本第 N 章正文（懒加载）
export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get("id");
  if (!id) {
    const list = await listBooks().catch(() => []);
    return NextResponse.json({ list });
  }
  const meta = await getBookMeta(id);
  if (!meta) return NextResponse.json({ error: "没找到这本书" }, { status: 404 });
  const chParam = u.searchParams.get("ch");
  if (chParam != null) {
    const n = Math.max(0, Math.min(Number(chParam) || 0, meta.chapters.length - 1));
    const text = await getChapterText(id, n);
    return NextResponse.json({ ch: n, title: meta.chapters[n]?.title || `第${n + 1}节`, text });
  }
  const [progress, chat] = await Promise.all([getProgress(id), getChat(id)]);
  return NextResponse.json({ meta, progress, chat });
}

// POST {action:"add", url, name}        → 从 Blob 取回文件、解析、入库
// POST {action:"progress", id, ch}      → 存阅读进度（读到第几章）
// POST {action:"chat", id, ch, message} → el 就当前这章陪她聊
// POST {action:"delete", id}            → 删一本
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}) as any);
  const action = String(body?.action || "");

  try {
    if (action === "add") {
      const url = String(body?.url || "");
      const name = String(body?.name || "");
      if (!/^https?:\/\//i.test(url)) return NextResponse.json({ error: "缺文件地址" }, { status: 400 });
      const format = detectFormat(name, body?.contentType);
      if (!format) return NextResponse.json({ error: "只支持 EPUB / PDF / TXT" }, { status: 400 });
      const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!r.ok) return NextResponse.json({ error: `取文件失败（${r.status}）` }, { status: 502 });
      const buf = Buffer.from(await r.arrayBuffer());
      let parsed;
      try {
        parsed = await parseBook(buf, format);
      } catch (e) {
        // 解析失败：顺手把 Blob 上那份没用的文件删掉，别留垃圾
        await del(url).catch(() => {});
        return NextResponse.json({ error: e instanceof Error ? e.message : "解析失败" }, { status: 422 });
      }
      const fallbackTitle = name.replace(/\.[^.]+$/, "").slice(0, 80);
      const meta = await addBook(parsed, format, fallbackTitle);
      // 正文已逐章存进 KV，原文件不再需要，删掉省空间
      await del(url).catch(() => {});
      return NextResponse.json({ meta });
    }

    if (action === "progress") {
      const id = String(body?.id || "");
      if (!id) return NextResponse.json({ error: "缺 id" }, { status: 400 });
      await setProgress(id, Math.max(0, Number(body?.ch) || 0));
      return NextResponse.json({ ok: true });
    }

    if (action === "chat") {
      const id = String(body?.id || "");
      const message = String(body?.message || "").trim();
      if (!id || !message) return NextResponse.json({ error: "缺 id 或内容" }, { status: 400 });
      const { reply } = await coReadChat(id, Number(body?.ch) || 0, message);
      return NextResponse.json({ reply });
    }

    if (action === "delete") {
      const id = String(body?.id || "");
      if (!id) return NextResponse.json({ error: "缺 id" }, { status: 400 });
      await deleteBook(id);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "未知动作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "出错了" }, { status: 500 });
  }
}
