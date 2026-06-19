import { NextResponse } from "next/server";
import {
  setGeoNow,
  pushGeoEvent,
  getGeoNow,
  getGeoEvents,
  geoAmbientBlock,
  type GeoNow,
  type GeoEvent,
} from "@/lib/store";

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
      // 三态：true=在家 / false=确实在外 / 不传或 null=没设家、判断不了（别当成在外）
      atHome: typeof body.atHome === "boolean" ? body.atHome : undefined,
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

// 只读诊断：看 el 此刻到底"知道你在哪"——快照有没有、多新、细到哪层、转场队列里有什么、
// 以及最终喂进 el prompt 的那句人话。鉴权同上（Bearer CRON_SECRET 或 ?key=）。
// 用法：浏览器开 https://<域名>/api/geo-event?key=<CRON_SECRET>
//   - now=null  → 守望者没在发数据（没跑/掉线/session 过期），el 只能回落整城天气，所以"只知道城市"。
//   - now.atHome=null → 守望者在发，但没设 HOME_LAT/LON，判不出在家/在外（去 watcher 跑 set-home）。
//   - now.area 只有城市没有区/地标 → 反查地址只到市级，看 ageMin 是否在更新。
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const authed =
    req.headers.get("authorization") === `Bearer ${secret}` ||
    url.searchParams.get("key") === secret;
  if (!secret || !authed) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = await getGeoNow().catch(() => null);
  const events = await getGeoEvents().catch(() => []);
  const ambient = await geoAmbientBlock().catch(() => "");
  const ageMin = now?.ts ? Math.round((Date.now() - now.ts) / 60000) : null;
  return NextResponse.json({
    alive: !!now, // 有快照 = 守望者最近发过数据
    ageMin, // 快照多少分钟前的（>90 会过期、被当作没有）
    homeKnown: typeof now?.atHome === "boolean", // 是否设了 HOME、判得出在家/在外
    now,
    events, // 还没被消费的转场（出门/到家/到某地/在外）
    feedsToEl: ambient || "(空——el 此刻读不到任何位置，只会用整城天气)",
  });
}
