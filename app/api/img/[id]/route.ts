import { getImage } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 把存在云端的图片（base64 data URL）作为真正的图片字节返回，供 <img src> 显示。
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const dataUrl = await getImage(params.id);
  if (!dataUrl) return new Response("not found", { status: 404 });
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return new Response("bad image", { status: 400 });
  const buf = Buffer.from(m[2], "base64");
  return new Response(buf, {
    headers: {
      "Content-Type": m[1],
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
