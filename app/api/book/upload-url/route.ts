import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// 书文件直传 Vercel Blob 的「客户端上传」token 端点。
// 为什么直传：Vercel 路由请求体上限 ~4.5MB，PDF/EPUB 整本常常更大，必须前端直接传 Blob、绕开这个限制。
// 这里只发放上传 token（限格式/大小）；真正的解析在 /api/book 的 add 里，从 Blob URL 取回再做。
export async function POST(req: Request): Promise<NextResponse> {
  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "application/epub+zip",
          "application/pdf",
          "text/plain",
          "application/octet-stream",
        ],
        maximumSizeInBytes: 80 * 1024 * 1024, // 80MB 上限，整本书绰绰有余
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        /* 解析另走 /api/book add，这里不需要回调 */
      },
    });
    return NextResponse.json(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "上传授权失败";
    if (/token/i.test(msg)) {
      return NextResponse.json(
        { error: "Blob 没接上：环境变量缺 BLOB_READ_WRITE_TOKEN" },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
