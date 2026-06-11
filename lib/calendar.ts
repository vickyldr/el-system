import { getCache, setCache } from "./store";
import { todayInBeijing } from "./notion";

// 判断今天是不是"休息日"（含法定节假日、调休补班）。
// 用国内的 timor.tech 节假日接口，查一次缓存一天；拿不到就退回"周六日=休息"。
export async function isRestDay(): Promise<boolean> {
  const date = todayInBeijing(); // YYYY-MM-DD（北京）
  const cacheKey = `el:daytype:${date}`;
  const cached = await getCache(cacheKey);
  if (cached === "rest") return true;
  if (cached === "work") return false;

  let rest = weekendFallback();
  try {
    const r = await fetch(`https://timor.tech/api/holiday/info/${date}`, { cache: "no-store" });
    if (r.ok) {
      const d: any = await r.json();
      // type.type: 0 工作日 / 1 周末 / 2 法定节假日 / 3 调休补班(要上班)
      const t = d?.type?.type;
      if (t === 1 || t === 2) rest = true;
      else if (t === 0 || t === 3) rest = false;
    }
  } catch {
    /* 接口挂了就用周末兜底 */
  }
  await setCache(cacheKey, rest ? "rest" : "work", 12 * 3600);
  return rest;
}

function weekendFallback(): boolean {
  const wd = new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  });
  return wd === "Sat" || wd === "Sun";
}
