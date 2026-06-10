import Anthropic from "@anthropic-ai/sdk";

// 中转站 base URL 形如 https://jeniya.chat/v1，而 Anthropic SDK 自己会拼 /v1/messages，
// 所以去掉结尾多余的 /v1（及末尾斜杠），避免 .../v1/v1/messages。
function normalizeBaseURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function getClaude(): Anthropic {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("缺少 CLAUDE_API_KEY 环境变量");
  return new Anthropic({
    apiKey,
    baseURL: normalizeBaseURL(process.env.CLAUDE_BASE_URL),
  });
}
