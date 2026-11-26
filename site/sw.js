// Сервис-воркер AI News: установка на телефон/компьютер и последние новости без сети.
// Номер сборки подставляет GitHub Actions при публикации — новая версия сбрасывает старый кэш.
const BUILD = "__BUILD__";
const CACHE = `ainews-${BUILD}`;
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ainews-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Сначала сеть, при неудаче — кэш (страница и данные: свежие, пока есть интернет).
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
    throw err;
  }
}

// Скрипты, стили, иконки: точный адрес (с ?v=) из кэша, иначе сеть; без сети — любая сохранённая версия.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const exact = await cache.match(req);
  if (exact) return exact;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const any = await cache.match(req, { ignoreSearch: true });
    if (any) return any;
    throw err;
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;  // шрифты Google и прочее — как обычно
  const isPage = req.mode === "navigate" || url.pathname.endsWith("/index.html");
  const isData = url.pathname.includes("/data/");
  e.respondWith(isPage || isData ? networkFirst(req) : cacheFirst(req));
});
