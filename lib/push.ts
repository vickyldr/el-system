import webpush from "web-push";
import { getPushSubs, setPushSubs } from "./store";

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:el@example.com", pub, priv);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export type PushPayload = { title: string; body: string; url?: string };

// 推给所有订阅的设备；顺便清掉失效的订阅。
export async function sendPush(payload: PushPayload): Promise<{ sent: number }> {
  if (!configure()) return { sent: 0 };
  const subs = await getPushSubs();
  if (!subs.length) return { sent: 0 };

  const alive: any[] = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        alive.push(sub);
        sent++;
      } catch (err: any) {
        const code = err?.statusCode;
        if (code !== 404 && code !== 410) alive.push(sub); // 暂时性错误保留，过期的丢掉
      }
    }),
  );
  if (alive.length !== subs.length) await setPushSubs(alive);
  return { sent };
}
