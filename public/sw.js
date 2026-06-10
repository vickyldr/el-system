// el-system service worker —— 先做最小可用版（套壳 + 离线兜底）。
// 主动推送（Web Push）会在后面的块里往这里加 push / notificationclick 监听。
const CACHE = "el-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
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

  // 其余资源：网络优先，断网时回落到缓存。
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request)),
  );
});
