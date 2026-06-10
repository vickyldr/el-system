import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const runtime = "nodejs";

// 上传图片/文件到 Vercel Blob，返回公开 URL。
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "上传格式不对" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "没有文件" }, { status: 400 });
  }
  try {
    const blob = await put(file.name || "upload", file, {
      access: "public",
      addRandomSuffix: true,
    });
    return NextResponse.json({ url: blob.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "上传失败";
    if (/token/i.test(message)) {
      return NextResponse.json(
        { error: "Blob 没接上：环境变量缺 BLOB_READ_WRITE_TOKEN" },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
