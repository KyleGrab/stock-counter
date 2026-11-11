// Security policy check: the app works with its Content-Security-Policy on, nothing it needs is
// blocked, the libraries come from this site (not outside servers), and injected inline script is refused.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const types = { js: "text/javascript", html: "text/html", svg: "image/svg+xml", json: "application/json" };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split("?")[0]); const p = path.join(root, u === "/" ? "index.html" : u); fs.readFile(p, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { "Content-Type": types[p.split(".").pop()] || "text/plain" }); r.end(b); }); });

(async () => {
  await new Promise(r => srv.listen(8795, r));
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 400, height: 860 } });
  const csp = [], outside = [], errs = [];
  ctx.on("page", p => p.on("console", m => { if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text()); }));
  ctx.on("request", rq => { const h = new URL(rq.url()).hostname; if (!/^(localhost|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(h) && !rq.url().startsWith("data:") && !rq.url().startsWith("blob:")) outside.push(rq.url()); });
  const pg = await ctx.newPage();
  pg.on("pageerror", e => errs.push(String(e)));
  pg.on("console", m => { if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text()); });
  await pg.goto("http://localhost:8795/");
  assert.ok(await pg.evaluate(() => !!window.Html5Qrcode && typeof qrcode === "function"), "scanner and QR libraries load from the site");
  await pg.getByText("Try it with example data").click();
  await pg.fill("#lg_user", "admin"); await pg.fill("#lg_pin", "246810"); await pg.locator("#lg_pin").press("Enter");
  await pg.getByRole("button", { name: "+ New job" }).waitFor();
  for (const t of ["stock", "scan", "counts", "more", "jobs"]) { await pg.evaluate(t => go(t), t); await pg.waitForTimeout(150); }
  // QR images (data: URLs) render
  const qr = await pg.evaluate(() => qrImg("https://example.test/?c=GS-0001", 4));
  assert.ok(/^data:image\//.test(qr), "QR image made");
  // printing opens a page and prints with no inline script
  const [popup] = await Promise.all([ctx.waitForEvent("page"), pg.evaluate(() => printSheet("t", [{ qr: qrImg("x", 4), title: "GS-0001", line1: "a", line2: "b" }], 3))]);
  await popup.waitForLoadState();
  assert.strictEqual(await popup.locator(".c").count(), 1, "print page has the sticker");
  assert.strictEqual(await popup.locator("script").count(), 0, "print page has no script");
  await popup.close();
  // an injected inline script must be refused by the policy, even if escaping ever failed
  await pg.evaluate(() => { const s = document.createElement("script"); s.textContent = "window.__inj = 1"; document.body.appendChild(s); });
  await pg.waitForTimeout(200);
  assert.strictEqual(await pg.evaluate(() => window.__inj), undefined, "inline script blocked");
  assert.ok(csp.some(t => /inline/i.test(t)), "the block was reported by the policy");
  const unexpected = csp.filter(t => !/inline/i.test(t));
  assert.deepStrictEqual(unexpected, [], "nothing the app needs is blocked");
  assert.deepStrictEqual(outside, [], "no requests to outside code servers");
  assert.deepStrictEqual(errs, [], "no script errors");
  console.log("csp: policy on, app works, inline script blocked, no outside code servers");
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
