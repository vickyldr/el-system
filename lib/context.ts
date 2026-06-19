import { getCache, setCache } from "./store";
import { isRestDay } from "./calendar";

// 「此刻处境」共享上下文——心跳(门/agent) 和聊天都喂同一套事实，单一真相在这里。
// 六要素：① 她大概在哪（geoAmbientBlock，在 store） ② 天气 ③ 时间·周几（各处自算 now）
// ④ 工作日/节假日 ⑤ 距上次说话多久。措辞统一，免得两条路一个知道一个不知道。

const CITY = process.env.CITY || "Hangzhou";

// 城市天气一行（"杭州 18° 小雨"），拿不到返回 ""。
// KV 缓存 ~25min：聊天每条都要、心跳每跳都要，天气又变得慢，别每次都打外网。
export async function cityWeatherLine(): Promise<string> {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) return "";
  const cached = await getCache("el:weatherline").catch(() => null);
  if (cached !== null && cached !== undefined) return cached;
  try {
    const r = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
        CITY,
      )}&appid=${key}&units=metric&lang=zh_cn`,
      { cache: "no-store", signal: AbortSignal.timeout(2500) },
    );
    if (!r.ok) return "";
    const d: any = await r.json();
    const line = `${CITY} ${Math.round(d.main?.temp ?? 0)}° ${d.weather?.[0]?.description ?? ""}`.trim();
    await setCache("el:weatherline", line, 25 * 60).catch(() => {});
    return line;
  } catch {
    return "";
  }
}

// 工作日 / 休息日（含法定节假日、调休补班）一句话——心跳和聊天共用同一措辞。
// isRestDay 自己带缓存+节假日接口；这里加 1.5s 上限，超时退周末兜底，别拖慢聊天。
export async function restDayLine(): Promise<string> {
  let rest: boolean;
  try {
    rest = await Promise.race([
      isRestDay(),
      new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
    ]);
  } catch {
    const wd = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Shanghai", weekday: "short" });
    rest = wd === "Sat" || wd === "Sun";
  }
  return rest
    ? "今天是休息日（周末或法定节假日），她不上班——别默认她在公司，可以约她、问她今天想干嘛。"
    : "今天是工作日。工作日的白天到傍晚她基本都在上班或通勤——别傻问她「今天去哪了」；想关心就关心上班累不累、下班没。";
}

// 距她上次说话多久——返回 "" 表示很近/没记录、没必要提。心跳和聊天共用。
export function sinceSpokeLine(lastSeen?: number): string {
  if (!lastSeen) return "";
  const min = Math.round((Date.now() - lastSeen) / 60000);
  if (min < 20) return "";
  if (min < 90) return `她上一次跟你说话大约在 ${min} 分钟前——不是刚刚。`;
  const hrs = Math.round(min / 60);
  if (hrs < 24)
    return `她已经大约 ${hrs} 小时没跟你说话了（这中间她在忙别的，工作日多半在上班）——聊天记录里那些是旧话，别当成此刻正在聊。`;
  const days = Math.round(hrs / 24);
  return `她已经大约 ${days} 天没跟你说话了。`;
}
