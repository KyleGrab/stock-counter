/*
 * Lets the app open with no signal.
 * App files: network first, so a new version shows up on the next open; the saved copy is
 * only used when there's no signal. Libraries: saved copy first (they never change).
 * Requests to the Google Sheet are never cached.
 */
var CACHE = "stock-counter-v4";
var SHELL = [
  "./", "index.html", "app.js", "core.js", "manifest.json", "icon.svg",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: "reload" })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (/google(usercontent)?\.com$/.test(url.hostname) && url.hostname !== "fonts.googleapis.com") return;
  var sameSite = url.origin === self.location.origin;
  if (sameSite) {
    var key = new Request(url.origin + url.pathname);   // ?c=GS-0001 links open the same app page
    e.respondWith(fetch(req, { cache: "no-cache" }).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      return res;
    }).catch(function () {
      return caches.open(CACHE).then(function (c) { return c.match(key).then(function (hit) { return hit || c.match("./"); }); });
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone()); return res; });
    });
  }));
});
