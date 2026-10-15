/* 极简 SW：缓存壳，API 永远走网络，不缓存旧价格。
   修复 chrome-extension 报错：只处理同源 http(s) GET；c.put 必须 await + try/catch，
   否则其返回的 rejected promise 无人处理，会报 Uncaught (in promise)。 */
const CACHE = "oil-v2";
self.addEventListener("install", (e) => {
  e.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try {
    url = new URL(e.request.url);
  } catch {
    return;
  }
  // 只处理 http(s)：chrome-extension://、moz-extension://、data: 等直接放行，不进 Cache
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  // 只缓存同源壳资源；跨域直接走网络，不缓存
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(e.request);
      try {
        const res = await fetch(e.request);
        // 只缓存同源基本响应；opaque/错误响应不进缓存
        if (res.ok && res.type === "basic") {
          try {
            await cache.put(e.request, res.clone());
          } catch {
            // 缓存写失败不影响返回
          }
        }
        return res;
      } catch {
        if (hit) return hit;
        return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })()
  );
});
