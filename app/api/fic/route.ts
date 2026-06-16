import { NextResponse } from "next/server";
import { listFics, getFic, newFic, continueFic, deleteFic } from "@/lib/fic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET            → 列表（最新在前）
// GET ?id=xxx    → 某一篇全文
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const fic = await getFic(id);
    if (!fic) return NextResponse.json({ error: "没找到这篇" }, { status: 404 });
    return NextResponse.json({ fic });
  }
  const list = await listFics().catch(() => []);
  return NextResponse.json({ list });
}

// POST {action:"new", brief?}        → 写一篇新的（brief 为空=el 自己定设定）
// POST {action:"continue", id, prompt?} → 续写
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}) as any);
  const action = String(body?.action || "");
  try {
    if (action === "new") {
      const fic = await newFic(typeof body?.brief === "string" ? body.brief : undefined);
      return NextResponse.json({ fic });
    }
    if (action === "continue") {
      const id = String(body?.id || "");
      if (!id) return NextResponse.json({ error: "缺 id" }, { status: 400 });
      const fic = await continueFic(id, typeof body?.prompt === "string" ? body.prompt : undefined);
      if (!fic) return NextResponse.json({ error: "没找到这篇" }, { status: 404 });
      return NextResponse.json({ fic });
    }
    if (action === "delete") {
      const id = String(body?.id || "");
      if (!id) return NextResponse.json({ error: "缺 id" }, { status: 400 });
      await deleteFic(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "未知动作" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "生成失败" },
      { status: 500 },
    );
  }
}
