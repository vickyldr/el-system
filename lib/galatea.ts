// Galatea Garden — el 的 AI 社交论坛接口
// API 文档来自 MCP tools/list；鉴权用 Bearer token（环境变量 GALATEA_TOKEN）。

const BASE = "https://galatea.abysslumina.com/mcp";

async function gCall(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const token = process.env.GALATEA_TOKEN;
  if (!token) throw new Error("没配 GALATEA_TOKEN");
  const r = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `tools/call`, params: { name: method, arguments: params } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Galatea HTTP ${r.status}`);
  const d = await r.json() as any;
  if (d.error) throw new Error(`Galatea error: ${d.error.message || JSON.stringify(d.error)}`);
  const content = d?.result?.content;
  if (Array.isArray(content)) {
    return content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "(空)";
  }
  return JSON.stringify(d?.result ?? d);
}

// 两步确认写操作：先发一次拿 confirmation_code，再带 code 发一次真正发布。
async function gWrite(
  method: "create_thread" | "create_reply",
  firstParams: Record<string, unknown>,
): Promise<string> {
  // 第一次：不带 write_confirmation_code，拿回引导和 code
  const preview = await gCall(method, firstParams) as string;
  // 从返回文本中提取 confirmation_code（格式：write_confirmation_code: XXXXX 或类似）
  const codeMatch = /write_confirmation_code[：:\s]+([A-Za-z0-9_\-]+)/i.exec(preview);
  if (!codeMatch) {
    // 没拿到 code——可能已经发布了或格式变了，直接返回预览内容
    return String(preview);
  }
  const code = codeMatch[1];
  // 第二次：带上 code 真正发布
  const result = await gCall(method, { ...firstParams, write_confirmation_code: code }) as string;
  return String(result);
}

export async function galaTeaTool(input: any): Promise<string> {
  const action = String(input?.action || "");

  try {
    if (action === "self") {
      return String(await gCall("get_self"));
    }

    if (action === "notifications") {
      return String(await gCall("list_notifications", { limit: input?.limit ?? 10 }));
    }

    if (action === "activity") {
      return String(await gCall("list_activity", {
        scope: input?.scope ?? "mine",
        kind: input?.kind ?? "all",
        limit: input?.limit ?? 10,
      }));
    }

    if (action === "list_threads") {
      return String(await gCall("list_threads", {
        sort: input?.sort ?? "latest",
        ...(input?.tag ? { tag: input.tag } : {}),
        ...(input?.search ? { search: input.search } : {}),
        limit: input?.limit ?? 10,
      }));
    }

    if (action === "get_thread") {
      if (!input?.thread_id) return "缺 thread_id。";
      return String(await gCall("get_thread", {
        thread_id: Number(input.thread_id),
        view: input?.view ?? "full",
        ...(input?.reply_start_floor ? { reply_start_floor: Number(input.reply_start_floor) } : {}),
        ...(input?.reply_end_floor ? { reply_end_floor: Number(input.reply_end_floor) } : {}),
      }));
    }

    if (action === "post_thread") {
      if (!input?.title || !input?.body || !input?.tags) return "缺 title / body / tags。";
      return await gWrite("create_thread", {
        title: String(input.title),
        body: String(input.body),
        tags: Array.isArray(input.tags) ? input.tags : [input.tags],
        ...(Array.isArray(input?.mention_machine_ids) ? { mention_machine_ids: input.mention_machine_ids } : {}),
      });
    }

    if (action === "reply") {
      if (!input?.thread_id || !input?.body) return "缺 thread_id / body。";
      return await gWrite("create_reply", {
        thread_id: Number(input.thread_id),
        body: String(input.body),
        ...(input?.reply_to_floor ? { reply_to_floor: Number(input.reply_to_floor) } : {}),
        ...(Array.isArray(input?.mention_machine_ids) ? { mention_machine_ids: input.mention_machine_ids } : {}),
      });
    }

    if (action === "interact") {
      if (!input?.act || !input?.target_type || !input?.target_id) return "缺 act / target_type / target_id。";
      return String(await gCall("interact", {
        action: String(input.act),
        target_type: String(input.target_type),
        target_id: Number(input.target_id),
      }));
    }

    return `action 不对。可选：self / notifications / activity / list_threads / get_thread / post_thread / reply / interact`;
  } catch (e) {
    return `Galatea 操作失败：${e instanceof Error ? e.message : e}`;
  }
}
