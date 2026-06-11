// el-system service worker —— 先做最小可用版（套壳 + 离线兜底）。
// 主动推送（Web Push）会在后面的块里往这里加 push / notificationclick 监听。
const CACHE = "el-shell-v3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // 接口请求不走缓存，永远拿最新状态。
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  // 页面导航：永远走网络，拿最新 HTML——避免旧壳引用已失效的脚本导致白屏。
  // 只有断网时才回落到缓存。
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((r) => r || caches.match("/"))),
    );
    return;
  }

  // 其它静态资源（_next 下都是带哈希的，永不串味）：缓存优先 + 后台更新。
  event.respondWith(
    caches.match(request).then((cached) => {
      const net = fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || net;
    }),
  );
});

// ── 主动推送 ──
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "El";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});
