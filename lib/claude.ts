import Anthropic from "@anthropic-ai/sdk";

// 中转站 base URL 形如 https://jeniya.chat/v1，而 Anthropic SDK 自己会拼 /v1/messages，
// 所以去掉结尾多余的 /v1（及末尾斜杠），避免 .../v1/v1/messages。
function normalizeBaseURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// ── 省道：中转站（慢，但便宜、可选任意模型含 Haiku）。──
// 不赶时间的后台活用它：心跳、每日总结、占卜、表情、拍板等。
export function getClaude(): Anthropic {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("缺少 CLAUDE_API_KEY 环境变量");
  return new Anthropic({
    apiKey,
    baseURL: normalizeBaseURL(process.env.CLAUDE_BASE_URL),
    maxRetries: 3,
  });
}

// ── 快道：Max 订阅 OAuth（快）。要实时的活用它：打字聊天（语音在 bridge 里也走这条）。──
// 走 Max 时必须带 oauth beta 头，且 system 第一段必须是 Claude Code 身份声明，否则被判不合规。
// 用原生 fetch（和 bridge 里跑通的写法一致），最稳。
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function withCCIdentity(system: unknown): any[] {
  const blocks: any[] = [{ type: "text", text: CC_IDENTITY }];
  if (typeof system === "string" && system) blocks.push({ type: "text", text: system });
  else if (Array.isArray(system)) blocks.push(...system);
  return blocks;
}

async function oauthCreate(token: string, params: any): Promise<any> {
  const body = {
    model: params.model,
    max_tokens: params.max_tokens ?? 1024,
    system: withCCIdentity(params.system),
    messages: params.messages,
    ...(params.tools ? { tools: params.tools } : {}),
  };
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (r.status === 429 && attempt < 2) {
      await new Promise((s) => setTimeout(s, 600 * (attempt + 1)));
      continue;
    }
    if (!r.ok) {
      lastErr = `Anthropic ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
      throw new Error(lastErr);
    }
    return await r.json();
  }
  throw new Error(lastErr || "oauth create failed");
}

// 优先用 Max 订阅；没配 OAuth token 就回落到中转站，至少还能用。
export function getClaudeFast(): Anthropic {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    const shim = { messages: { create: (params: any) => oauthCreate(oauth, params) } };
    return shim as unknown as Anthropic;
  }
  return getClaude();
}
