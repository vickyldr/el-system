import { NextResponse } from "next/server";
import { setGeoNow, pushGeoEvent, type GeoNow, type GeoEvent } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 本地「守望者」（geo/watcher.py，跑在她常开的设备上）把位置信号 POST 到这里。
// 隐私铁律：富化全在守望者本地做，这里只接到"区域 + 附近地标 + 天气"这种人话，
// 精确坐标永不进入云端。鉴权同心跳：Bearer CRON_SECRET 或 ?key=。
//
// 两类负载：
//   { type:"snapshot", area, place, weather, raining, accuracy, atHome }  → 当下位置快照（覆盖）
//   { type:"left_home"|"arrived_place"|"outside_checkin"|"back_home", summary } → 转场事件（入队）
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const authed =
    req.headers.get("authorization") === `Bearer ${secret}` ||
    url.searchParams.get("key") === secret;
  if (!secret || !authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const type = String(body?.type || "snapshot");
  const clip = (s: any, n = 120) => (typeof s === "string" ? s.slice(0, n) : undefined);

  if (type === "snapshot") {
    const g: GeoNow = {
      area: clip(body.area),
      place: clip(body.place),
      weather: clip(body.weather, 60),
      raining: !!body.raining,
      accuracy: body.accuracy === "coarse" ? "coarse" : "good",
      atHome: !!body.atHome,
      ts: Date.now(),
    };
    await setGeoNow(g);
    return NextResponse.json({ ok: true, stored: "snapshot" });
  }

  const kinds = ["left_home", "arrived_place", "outside_checkin", "back_home"] as const;
  if ((kinds as readonly string[]).includes(type)) {
    const summary = clip(body.summary, 200);
    if (!summary) return NextResponse.json({ error: "summary required" }, { status: 400 });
    const ev: GeoEvent = { kind: type as GeoEvent["kind"], summary, ts: Date.now() };
    await pushGeoEvent(ev);
    // 转场往往也意味着位置变了——顺带把快照里能给的字段也更新一下。
    if (body.area || body.place || body.weather) {
      await setGeoNow({
        area: clip(body.area),
        place: clip(body.place),
        weather: clip(body.weather, 60),
        raining: !!body.raining,
        accuracy: body.accuracy === "coarse" ? "coarse" : "good",
        atHome: type === "back_home",
        ts: Date.now(),
      });
    }
    return NextResponse.json({ ok: true, stored: "event", kind: type });
  }

  return NextResponse.json({ error: "unknown type" }, { status: 400 });
}

export async function POST(req: Request) {
  return handle(req);
}
