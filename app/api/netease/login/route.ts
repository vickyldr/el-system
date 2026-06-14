import { NextResponse } from "next/server";
import { qrKey, qrImageUrl, qrCheck, myRecord } from "@/lib/netease-api";
import { getCache } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 无 key：生成一个登录二维码。带 ?key=：轮询扫码状态（803=成功，cookie 已存服务端）。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const ip = url.searchParams.get("ip") || undefined; // 临时换 IP 测试用

  // 诊断：看 Vercel 有没有读到中转、能不能连上中转、中转转发网易云回了啥。
  if (url.searchParams.get("debug")) {
    // 顺便看缓存里到底有没有存住 cookie/uid，并实测一次读听歌记录。
    const cookieStored = await getCache("el:netease:cookie").catch(() => null);
    const uidStored = await getCache("el:netease:uid").catch(() => null);
    const recordSample = await myRecord(false).catch((e: any) => `record错误：${e?.message || e}`);
    const relay = process.env.NETEASE_RELAY;
    let relayStatus: any = null;
    let relayBody: any = null;
    if (relay) {
      try {
        const rr = await fetch(relay.replace(/\/$/, ""), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Relay-Secret": process.env.NETEASE_RELAY_SECRET || "",
          },
          body: JSON.stringify({ path: "login/qrcode/unikey", form: "type=1", cookie: "os=pc" }),
        });
        relayStatus = rr.status;
        relayBody = JSON.stringify(await rr.json().catch(() => ({}))).slice(0, 300);
      } catch (e: any) {
        relayBody = `连不上中转：${e?.message || e}`;
      }
    }
    // 真·加密请求（走 weapiPost，配了中转就经中转）——这才是登录真实走的路。
    const real = await qrKey(ip).catch((e: any) => ({ unikey: "", message: String(e?.message || e) }));
    return NextResponse.json({
      cookieStored: cookieStored ? `有(${String(cookieStored).length}字符)` : "无",
      uidStored: uidStored || "无",
      recordSample: typeof recordSample === "string" ? recordSample.slice(0, 300) : recordSample,
      relaySet: !!relay,
      relayStatus,
      relayBody,
      real,
    });
  }

  if (key) {
    const r = await qrCheck(key, ip).catch(() => ({ code: 0 }));
    return NextResponse.json(r);
  }
  const k = await qrKey(ip).catch((e) => ({ unikey: "", message: String(e?.message || e) }) as any);
  if (!k.unikey)
    return NextResponse.json(
      { error: "拿不到二维码", detail: `code=${k.code ?? "?"} ${k.message ?? ""}` },
      { status: 502 },
    );
  return NextResponse.json({ key: k.unikey, qr: qrImageUrl(k.unikey) });
}
