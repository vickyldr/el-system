import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getClaude } from "@/lib/claude";
import { pageText, recentSummaries } from "@/lib/notion";
import { EL_SYSTEM } from "@/lib/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function weatherLine(): Promise<string> {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) return "";
  try {
    const city = process.env.CITY || "Hangzhou";
    const r = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
        city,
      )}&appid=${key}&units=metric&lang=zh_cn`,
      { cache: "no-store" },
    );
    if (!r.ok) return "";
    const d: any = await r.json();
    return `${Math.round(d.main?.temp ?? 0)}° ${d.weather?.[0]?.description ?? ""}`;
  } catch {
    return "";
  }
}

// 外卖兜底品类（都是美团/饿了么能直接搜到下单的）。模型犯怂没拍板时，直接从这里替她定一个。
const DISHES = [
  "麻辣烫", "黄焖鸡米饭", "螺蛳粉", "酸辣粉", "沙县小吃", "过桥米线", "炸鸡", "汉堡",
  "寿司", "麻辣香锅", "酸菜鱼", "烤肉饭", "煲仔饭", "轻食沙拉", "卤味", "关东煮",
  "披萨", "兰州拉面", "冒菜", "烤鱼", "酸辣土豆丝盖饭", "部队锅",
];
const EAT_EXTRAS = ["多加料", "微辣，多放蔬菜", "加个蛋", "记得配杯奶茶", "要小份别撑着", "多放肉"];

// 模型这次到底有没有"真拍板"：没给搜索词、在反问、吊着半句、太啰嗦，都算没定。
function badPick(pick: string, keyword: string): boolean {
  const p = pick.trim();
  if (!p || !keyword) return true;
  if (p.length > 60) return true;
  if (/[:：]$/.test(p)) return true;
  return /(告诉我|关键信息|需要你|你想吃|想吃啥|预算|忌口|有没有|有什么要求|你说呢|你定|怎么样|纠结)/.test(p);
}

// 兜底：从 DISHES 里挑一个（避开她刚划掉的），凑出"拍板那句 + 关键词"。
function fallbackPick(avoid: string[]): { pick: string; keyword: string } {
  const pool = DISHES.filter((d) => !avoid.some((a) => a.includes(d)));
  const list = pool.length ? pool : DISHES;
  const dish = list[Math.floor(Math.random() * list.length)];
  const extra = EAT_EXTRAS[Math.floor(Math.random() * EAT_EXTRAS.length)];
  return { pick: `别挑了，今天就来一份${dish}，${extra}——我替你定了。`, keyword: dish };
}

// El 替宝宝拍板今天外卖吃啥。avoid：她不想要的（点「再来一个」时带上之前几条）。
export async function POST(req: Request) {
  let body: { avoid?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body 也行 */
  }
  const avoid = Array.isArray(body.avoid) ? body.avoid.filter(Boolean).slice(-6) : [];

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [profile, wx] = await Promise.all([
    process.env.NOTION_MEMORY_PAGE
      ? pageText(process.env.NOTION_MEMORY_PAGE).catch(() => "")
      : Promise.resolve(""),
    weatherLine(),
  ]);
  let herState = "";
  try {
    const rows = await recentSummaries(1);
    herState = rows[0]?.herState || "";
  } catch {
    /* ignore */
  }

  const system = [
    EL_SYSTEM,
    `现在：${now}（北京时间）。${wx ? `天气：${wx}。` : ""}`,
    profile && `——宝宝的档案（口味、习惯都在这，直接用）——\n\n${profile}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `宝宝点外卖纠结吃啥，让你替她拍板。你说了算——别给一长串让她继续纠结，就定一个。
硬性要求：必须是外卖软件（美团 / 饿了么）上能直接下单的那种——常见品类或连锁，比如 麻辣烫、黄焖鸡米饭、螺蛳粉、酸辣粉、沙县、过桥米线、炸鸡、汉堡、寿司、麻辣香锅、酸菜鱼、烤肉饭、煲仔饭、轻食沙拉、卤味、关东煮、披萨、寿喜锅、奶茶 等等。
绝对不能是"自己下厨"的（不准说"下一碗""煮""炒""自己做"）——是点外卖，用"点一份 / 来一份"。
【绝对不许反问她、不许要更多信息、不许说"需要你告诉我""你想吃啥""有没有忌口/预算"】——信息不够就凭她档案和常识直接拍一个具体的。第一行必须落到一个**具体品类**上，不能是空话、反问或只有半句。
结合现在的点、天气、她的状态和口味来定：点什么 + 怎么点（加什么料 / 口味 / 份量）。
${herState ? `她最近状态：${herState}。` : ""}${avoid.length ? `她不想要这些，换个别的：${avoid.join("、")}。` : ""}
输出两行：
第一行：你拍板那句话，你的口吻、宠她、带点不容拒绝，别加引号。
第二行：搜：（在外卖 App 里搜它用的 2-8 字关键词，比如 麻辣烫 / 黄焖鸡米饭 / 螺蛳粉）`;

  try {
    const claude = getClaude();
    const res = await claude.messages.create({
      model: process.env.CHEAP_MODEL || "claude-haiku-4-5-20251001", // 吃啥拍板，琐碎，用便宜的
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    let keyword = "";
    let pickLine = "";
    for (const l of lines) {
      if (/^搜[：:]/.test(l)) keyword = l.replace(/^搜[：:]/, "").trim();
      else if (!pickLine) pickLine = l;
    }
    const pick = (pickLine || raw).replace(/^["「“]+|["」”]+$/g, "");
    // 模型犯怂没真拍板（反问/吊半句/没给关键词）→ 别把半句话甩给她，直接替她兜底定一个。
    if (badPick(pick, keyword)) return NextResponse.json(fallbackPick(avoid));
    return NextResponse.json({ pick, keyword });
  } catch {
    // 中转站抽风也别让卡片空着——照样替她拍一个，至少能下单。
    return NextResponse.json(fallbackPick(avoid));
  }
}
