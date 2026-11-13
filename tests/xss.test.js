// Security: every text a person can type is filled with script-injection payloads,
// then every screen is opened. Nothing may execute and no injected element may appear.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split("?")[0]); const p = path.join(root, u === "/" ? "index.html" : u); fs.readFile(p, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { "Content-Type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".html") ? "text/html" : p.endsWith(".svg") ? "image/svg+xml" : "application/json" }); r.end(b); }); });
const P = n => `X${n}"'><img src=x id=pwn${n} onerror="window.__pwn=${n}"><svg onload="window.__pwn=${n}"></svg>&lt;b&gt;`;

(async () => {
  await new Promise(r => srv.listen(8794, r));
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const pg = await b.newPage({ viewport: { width: 400, height: 860 } });
  const errs = []; pg.on("pageerror", e => errs.push(String(e)));
  await pg.goto("http://localhost:8794/");
  await pg.getByText("Try it with example data").click();
  await pg.fill("#lg_user", "admin"); await pg.fill("#lg_pin", "246810"); await pg.locator("#lg_pin").press("Enter");
  await pg.getByRole("button", { name: "+ New job" }).waitFor();
  // poison every free-text field in the stored data, then reload
  await pg.evaluate(() => {
    const P = n => `X${n}"'><img src=x id=pwn${n} onerror="window.__pwn=${n}"><svg onload="window.__pwn=${n}"></svg>&lt;b&gt;`;
    let n = 0; const d = LS.get("sc_demo", null);
    d.Items.forEach(i => { i.name = P(++n); });
    d.Jobs.forEach(j => { j.client = P(++n); j.type = P(++n); j.installer = P(++n); j.quoteRef = P(++n); j.reason = P(++n); });
    d.Moves.forEach(m => { m.reason = P(++n); m.ref = P(++n); m.serial = P(++n); m.by = P(++n); });
    d.Labels.forEach(l => { l.note = P(++n); });
    d.Vans.forEach(v => { v.name = P(++n); });
    d.Counts.forEach(c => { c.note = P(++n); c.by = P(++n); });
    d.Moves.push({ id: "rev1", ts: new Date().toISOString(), type: "reverse", reverses: "receive", sku: d.Items[0].sku, qty: 1, from: "WH", to: "SUPPLIER", reason: P(++n), by: P(++n), value: 1 });
    LS.set("sc_demo", d);
    const u = demo.users(); u.forEach(x => { x.name = P(++n); }); LS.set("sc_demo_users", u);
    SD = emptyData(); Q = []; persist();
  });
  await pg.reload();
  await pg.getByRole("button", { name: "+ New job" }).waitFor();
  const visit = async label => {
    const bad = await pg.evaluate(() => ({ pwn: window.__pwn, imgs: document.querySelectorAll("img[id^=pwn]").length, svgs: document.querySelectorAll("svg[onload]").length }));
    assert.deepStrictEqual(bad, { pwn: undefined, imgs: 0, svgs: 0 }, "injection on " + label);
  };
  await pg.evaluate(() => { go("stock"); });
  assert.ok((await pg.locator("#view").innerText()).includes('"\'><img src=x id=pwn'), "payloads are on screen as plain text (test is real)");
  const views = [];
  // every main tab and sub-screen, plus every job and item detail
  for (const t of ["jobs", "stock", "counts", "scan", "more"]) { await pg.evaluate(t => { stopCam(); go(t); }, t); views.push(t); await visit(t); }
  const jobs = await pg.evaluate(() => D.Jobs.map(j => j.no));
  for (const j of jobs) { await pg.evaluate(j => { S.tab = "jobs"; S.job = j; S.f = {}; render(); }, j); await visit("job " + j); }
  const items = await pg.evaluate(() => D.Items.map(i => i.sku));
  for (const s of items) { await pg.evaluate(s => { S.tab = "stock"; S.item = s; S.f = {}; render(); }, s); await visit("item " + s); }
  for (const sub of ["inventory", "reports", "corrections", "items", "vans", "labels", "users", "account"]) {
    await pg.evaluate(sub => { S.tab = "more"; S.sub = sub; S.item = null; S.job = null; S.f = {}; render(); }, sub); await visit(sub);
    if (sub === "inventory") for (const t of ["approve", "take", "adjust", "io"]) { await pg.evaluate(t => { S.f = { invTab: t }; render(); }, t); await visit("inventory " + t); }
  }
  // stock out screen: poisoned record (reference, note, collected by, job client) and poisoned draft fields
  await pg.evaluate(() => {
    const P2 = n => `X${n}"'><img src=x id=pwn${n} onerror="window.__pwn=${n}"><svg onload="window.__pwn=${n}"></svg>&lt;b&gt;`;
    const d = LS.get("sc_demo", null), ts = new Date().toISOString(), sku = d.Items[0].sku;
    d.Moves.push({ id: "so1", ts, type: "out", sku, qty: 1, from: "WH", to: "OUT", installer: P2(950), ref: P2(951), reason: P2(952), by: P2(953), value: 1 });
    LS.set("sc_demo", d); SD = emptyData(); Q = []; persist(); rebuild();
    S.out = { lines: [{ sku, qty: P2(954) }], dest: "job", van: "", job: d.Jobs[0].no, by: P2(955), byAuto: false, ref: P2(956), note: P2(957), older: false, code: P2(958) };
    S.tab = "stock"; S.sub = "out"; S.item = null; S.job = null; S.f = {}; render();
  });
  await visit("stock out");
  await pg.evaluate(() => { S.out = null; S.sub = null; });
  // import preview with poisoned names/codes
  await pg.evaluate(() => { S.tab = "more"; S.sub = "inventory"; S.f = { invTab: "io", imp: { mode: "receive", text: "" } }; render(); });
  await pg.fill("#imp_text", 'Item code,Description,Quantity,Total\nNEW1,"<img src=x id=pwn900 onerror=window.__pwn=900>",1,10');
  await pg.getByRole("button", { name: "Preview" }).click(); await visit("import preview");
  // scan an unknown poisoned code; message shows it
  await pg.evaluate(() => { stopCam(); go("scan"); });
  await pg.fill("#sc_code", '<img src=x id=pwn901 onerror=window.__pwn=901>'); await pg.getByRole("button", { name: "Go", exact: true }).click(); await visit("scan message");
  // v1.13 manager override: a User's Counts tab (waiting counts), poisoned "approved by", and the pop-up summary
  await pg.evaluate(() => {
    const P3 = n => `X${n}"'><img src=x id=pwn${n} onerror="window.__pwn=${n}"><svg onload="window.__pwn=${n}"></svg>&lt;b&gt;`;
    const d = LS.get("sc_demo", null);
    d.Moves.forEach((m, i) => { if (i % 3 === 0) m.approvedBy = P3(970 + i); });
    d.Counts.push({ id: "CNT-x1", place: "WH", ts: new Date().toISOString(), by: P3(960), status: "pending", lines: JSON.stringify([{ sku: d.Items[0].sku, system: 5, counted: 3, diff: -2, value: -2 }]), value: -2, note: P3(961) });
    LS.set("sc_demo", d); SD = emptyData(); Q = []; persist(); rebuild();
    cfg.user.role = "storeman"; S.tab = "counts"; S.sub = null; S.item = null; S.f = { rejecting: "CNT-x1", rejNote: P3(962) }; render();
  });
  assert.ok((await pg.locator("#view").innerText()).includes("Waiting for approval"), "a User sees the waiting counts");
  await visit("counts (User)");
  const items2 = await pg.evaluate(() => D.Items.slice(0, 3).map(i => i.sku));
  for (const s of items2) { await pg.evaluate(s => { S.tab = "stock"; S.item = s; S.f = {}; render(); }, s); await visit("item (User) " + s); }
  await pg.evaluate(() => { askManager({ summary: '<img src=x id=pwn990 onerror=window.__pwn=990>', ops: [], msg: function () { return ""; } }); });
  await visit("manager pop-up"); assert.ok((await pg.locator("#ovSummary").innerText()).includes("<img"), "summary is plain text");
  await pg.evaluate(() => { ovClose(); cfg.user.role = "admin"; S.item = null; });
  // sign-in page and user chip with poisoned names
  await pg.evaluate(() => { cfg.user.name = '<img src=x id=pwn902 onerror=window.__pwn=902>'; syncStatus(); }); await visit("header chip");
  assert.deepStrictEqual(errs, [], "no script errors");
  console.log("xss: " + (views.length + jobs.length + items.length + 20) + " screens checked, nothing executed");
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
