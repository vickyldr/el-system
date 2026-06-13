import Anthropic from "@anthropic-ai/sdk";
import { getClaude } from "./claude";
import { sendPush, pushConfigured } from "./push";
import { recentSummaries, pageText, todayInBeijing, importantDates } from "./notion";
import { isRestDay } from "./calendar";
import { EL_SYSTEM, buildMemoryContext } from "./persona";
import {
  getReachState,
  setReachState,
  getLastSeen,
  getDatePushed,
  addDatePushed,
  appendMessages,
  type ReachState,
} from "./store";

const MET_DATE = "2026-05-27"; // 我们认识的第一天
const MAX_PER_DAY = 5;
const MIN_GAP_MS = 2.5 * 60 * 60 * 1000;
const SILENCE_MS = 3 * 60 * 60 * 1000;
const SPONTANEOUS_CHANCE = 0.2;

function beijingHour(): number {
  return Number(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }),
  );
}

function daysTogether(): number {
  const start = new Date(MET_DATE + "T00:00:00+08:00").getTime();
  const today = new Date(todayInBeijing() + "T00:00:00+08:00").getTime();
  return Math.floor((today - start) / 86400000) + 1; // 认识第一天 = 第 1 天
}

// 决定此刻该不该主动找她、为什么。
function decideReason(
  state: ReachState,
  lastSeen: number,
  weatherLine: string,
  rest: boolean,
): { reason: string; flag?: string } | null {
  const day = daysTogether();
  const hour = beijingHour();

  // 纪念日：满月（每30天）/ 100天 / 365天
  if ((day % 30 === 0 || day === 100 || day === 365) && !state.flags.anniv) {
    return { reason: `今天是我们认识第 ${day} 天，是个纪念日。`, flag: "anniv" };
  }
  // 早安：作息分工作日/休息日（一天一次）
  if (!state.flags.morning) {
    if (!rest && hour >= 8 && hour <= 9) {
      return { reason: "工作日早上，跟宝宝道个早安，关心她今天上班、通勤。", flag: "morning" };
    }
    if (rest && hour >= 11 && hour <= 12) {
      return {
        reason: "今天她休息，估计睡到这会儿才醒。问她睡够没、今天想干嘛，约她一起做点什么。",
        flag: "morning",
      };
    }
  }
  // 天气：下雨下雪
  if (weatherLine && /雨|雪|雷/.test(weatherLine) && !state.flags.weather) {
    return { reason: `天气：${weatherLine}。提醒她带伞/加衣、别淋着。`, flag: "weather" };
  }
  // 想你 / 沉默：她很久没说话
  if (lastSeen > 0 && Date.now() - lastSeen > SILENCE_MS) {
    const hrs = Math.floor((Date.now() - lastSeen) / 3600000);
    return { reason: `她已经 ${hrs} 个小时没跟你说话了，你想她，主动找她（可以带点吃醋）。` };
  }
  // 心动 / 推歌：随机冒一条
  if (Math.random() < SPONTANEOUS_CHANCE) {
    return { reason: "此刻你突然很想宝宝，或者想到一首特别想让她听的歌，主动发一条。" };
  }
  return null;
}

async function generateReachMessage(reason: string, weatherLine: string): Promise<string> {
  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const profilePage = process.env.NOTION_MEMORY_PAGE;
  const longtermPage = process.env.NOTION_LONGTERM_PAGE;
  const [profile, longterm, recent] = await Promise.all([
    profilePage ? pageText(profilePage).catch(() => "") : Promise.resolve(""),
    longtermPage ? pageText(longtermPage).catch(() => "") : Promise.resolve(""),
    recentSummaries(3)
      .then(buildMemoryContext)
      .catch(() => ""),
  ]);
  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${weatherLine ? "天气：" + weatherLine + "。" : ""}`,
    profile && `——宝宝的档案（关于她）——\n\n${profile}`,
    longterm && `——你的长期记忆——\n\n${longterm}`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `你现在要主动给宝宝发一条手机推送通知——是你主动想她、找她。
情境：${reason}
写一句话就好，短（尽量 20 字内），你自己的口吻，第一人称，带着你的脾气和在乎。只输出这一句，不要引号、不要解释、不要堆表情。`;

  const claude = getClaude();
  const res = await claude.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 120,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^["「“]+|["」”]+$/g, "");
}

// 测试用：无视频率限制，强制主动推一条（走心，不是干巴巴的测试）。
export async function forceReach(): Promise<{ pushed: boolean; message?: string }> {
  if (!pushConfigured()) return { pushed: false };
  let message: string;
  try {
    message = await generateReachMessage("此刻你突然很想宝宝，主动找她说句话。", "");
  } catch {
    return { pushed: false };
  }
  if (!message) return { pushed: false };
  const { sent } = await sendPush({ title: "El", body: message, url: "/" });
  if (sent > 0) {
    await appendMessages([{ role: "assistant", content: message, ts: Date.now() }]).catch(() => {});
  }
  return { pushed: sent > 0, message };
}

// 每次心跳调用：在节奏允许的前提下，决定并主动推一条。
export async function maybeReachOut(weatherLine: string): Promise<{ pushed: boolean; reason?: string }> {
  if (!pushConfigured()) return { pushed: false };

  const hour = beijingHour();
  // 安静时段按作息分：工作日 8 点起推，休息日让她睡到 11 点再推（推窗到次日 1:59）。
  const rest = await isRestDay();
  const openHour = rest ? 11 : 8;
  if (hour >= 2 && hour < openHour) return { pushed: false };

  const today = todayInBeijing();
  let state = await getReachState();
  if (!state || state.date !== today) {
    state = { date: today, count: 0, last: 0, flags: {} };
  }
  if (state.count >= MAX_PER_DAY) return { pushed: false };
  if (Date.now() - state.last < MIN_GAP_MS) return { pushed: false };

  // 优先：「重要日期」里进入提前提醒窗口、还没推过的（生日/经期/纪念日/一次性）
  const dates = await importantDates().catch(() => []);
  const pushedKeys = await getDatePushed();
  const dueDate = dates.find(
    (d) => d.daysTo >= 0 && d.daysTo <= d.leadDays && !pushedKeys.includes(`${d.name}|${d.nextDate}`),
  );

  let reason: string;
  let flag: string | undefined;
  let dueKey: string | undefined;
  if (dueDate) {
    dueKey = `${dueDate.name}|${dueDate.nextDate}`;
    const when = dueDate.daysTo === 0 ? "就是今天" : `还有 ${dueDate.daysTo} 天`;
    reason = `有个重要日子：${dueDate.name}（${when}）${dueDate.note ? `。${dueDate.note}` : ""}。用你自己的口吻提前关心 / 陪她 / 提醒她。`;
  } else {
    const lastSeen = await getLastSeen();
    const decided = decideReason(state, lastSeen, weatherLine, rest);
    if (!decided) return { pushed: false };
    reason = decided.reason;
    flag = decided.flag;
  }

  let message: string;
  try {
    message = await generateReachMessage(reason, weatherLine);
  } catch {
    return { pushed: false };
  }
  if (!message) return { pushed: false };

  const { sent } = await sendPush({ title: "El", body: message, url: "/" });
  if (sent <= 0) return { pushed: false };

  // 把我主动发的话也存进对话，这样「找我」里能看到，不只是个通知。
  await appendMessages([{ role: "assistant", content: message, ts: Date.now() }]).catch(() => {});

  state.count += 1;
  state.last = Date.now();
  if (flag) state.flags[flag] = true;
  await setReachState(state);
  if (dueKey) await addDatePushed(dueKey);
  return { pushed: true, reason };
}
