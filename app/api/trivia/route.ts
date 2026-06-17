import { NextResponse } from "next/server";
import { getDailyTrivia } from "@/lib/trivia";
import { todayInBeijing } from "@/lib/notion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 40; // 首次当天要联网搜 + 过一次模型，给足时限

// GET → 今天的电影冷知识（按北京日期，首次按需生成并缓存，之后秒回）
export async function GET() {
  const trivia = await getDailyTrivia(todayInBeijing()).catch(() => null);
  return NextResponse.json({ trivia });
}
