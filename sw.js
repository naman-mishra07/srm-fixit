const CACHE_NAME = "srm-fixit-shell-v24";
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./student.html",
  "./admin.html",
  "./archive.html",
  "./admin.js?v=phase7-archive-3",
  "./staff-login.html",
  "./developer-login.html",
  "./style.css",
  "./supabase-client.js",
  "./pwa-install.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await cache.addAll(APP_SHELL);
    // Keep the client library available so cached screens can render offline.
    await cache.add(SUPABASE_JS).catch(() => {});
  }));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith("srm-fixit-shell-") && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET") return;
  const isAppFile = url.origin === self.location.origin;
  const isSupabaseLibrary = url.href === SUPABASE_JS;
  if (!isAppFile && !isSupabaseLibrary) return;

  // Network-first keeps app updates fresh and falls back to the saved shell offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") return cache.match("./index.html");
      return Response.error();
    }
  })());
});
