/*
 * Lets the app open with no signal. App files and the two scanner/QR libraries are kept on the phone.
 * Each time the app opens with signal, the newest files are fetched in the background and used on
 * the next open. Requests to the Google Sheet are never cached.
 */
var CACHE = "stock-counter-v1";
var SHELL = [
  "./", "index.html", "app.js", "core.js", "manifest.json", "icon.svg",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
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
  e.respondWith(caches.open(CACHE).then(function (c) {
    // ?c=GS-0001 links open the same app page
    return c.match(req, { ignoreSearch: sameSite }).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === "opaque")) c.put(sameSite ? new Request(url.origin + url.pathname) : req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || fresh;
    });
  }));
});
