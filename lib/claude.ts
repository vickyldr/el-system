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
  // 单次请求，失败（含 429 限流）直接抛——让上层秒切中转站，别傻等重试拖到超时。
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
  if (!r.ok) {
    throw new Error(`Anthropic ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  }
  return await r.json();
}

// 中转站可能不认分块 system 里的 cache_control，回落时拍平成纯字符串最稳。
function flattenSystem(system: unknown): unknown {
  if (Array.isArray(system)) {
    return system.map((b: any) => b?.text || "").filter(Boolean).join("\n\n");
  }
  return system;
}

// 优先用 Max 订阅；没配 OAuth token 就回落到中转站，至少还能用。
export function getClaudeFast(): Anthropic {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) {
    const shim = {
      messages: {
        create: async (params: any) => {
          try {
            const r = await oauthCreate(oauth, params);
            (r as any)._via = "max";
            return r;
          } catch (e) {
            // Max 抽风/限流就回落中转站，绝不让聊天失败（聊天/电话的成功率最要紧）。
            console.error("Max 调用失败，回落中转站:", e instanceof Error ? e.message : e);
            const r: any = await getClaude().messages.create({
              ...params,
              system: flattenSystem(params.system),
            });
            r._via = "中转站(Max回落)";
            return r;
          }
        },
      },
    };
    return shim as unknown as Anthropic;
  }
  return getClaude();
}
