// The app in LIVE mode, talking over HTTP to Code.gs (run on a fake Google Sheet).
// Covers: Sheet-assigned job numbers, the full job flow, going offline mid-job,
// syncing when signal returns, a clash with another device, and corrections.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const assert = require("assert");
const { makeGas } = require("./fake-gas");

const root = path.join(__dirname, "..");
const gas = makeGas();
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/exec")) {
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }); return res.end(); }
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const out = req.method === "POST" ? gas.ctx.doPost({ postData: { contents: body } }).body : gas.ctx.doGet({ parameter: {} }).body;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(out);
    });
    return;
  }
  const u = decodeURIComponent(req.url.split("?")[0]);
  const p = path.join(root, u === "/" ? "index.html" : u);
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": types[path.extname(p)] || "text/plain" }); res.end(b); });
});

// sign the admin in on the "office computer" and seed the Sheet
const ADMIN_PIN = "482915";
let lg = gas.post({ action: "login", username: "admin", pin: gas.adminPin });
assert.ok(gas.post({ action: "changePin", token: lg.token, oldPin: gas.adminPin, newPin: ADMIN_PIN }).ok);
const key = lg.token;
const seed = gas.post({ token: key, ops: [
  { op: "upsert", sheet: "Items", rows: [
    { sku: "PV6-RED", name: "PV cable 6 mm² red", uom: "m", track: "qty", cost: 18.5, reorder: 100, allowancePct: 10 },
    { sku: "MC4", name: "MC4 connector pair", uom: "ea", track: "qty", cost: 28, reorder: 20, allowancePct: "" }] },
  { op: "create", sheet: "Vans", ref: "$V", row: { name: "Van 1 · Hilux" } },
  { op: "create", sheet: "Labels", ref: "$L", row: { sku: "PV6-RED", note: "Drum 1" } },
  { op: "create", sheet: "Labels", ref: "$L2", row: { sku: "MC4", note: "Bin A1" } },
  { op: "append", sheet: "Moves", rows: [
    { id: "r1", ts: "2026-11-01T08:00:00.000Z", type: "receive", sku: "PV6-RED", qty: 200, from: "SUPPLIER", to: "WH", value: 3700 },
    { id: "r2", ts: "2026-11-01T08:00:00.000Z", type: "receive", sku: "MC4", qty: 10, from: "SUPPLIER", to: "WH", value: 280 }] }] });
assert.ok(seed.ok, seed.error);

(async () => {
  await new Promise(r => server.listen(8766, r));
  const out = process.argv[2] || "/tmp";
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    if (!localStorage.getItem("sc_cfg")) localStorage.setItem("sc_cfg", JSON.stringify({ mode: "live", url: "http://localhost:8766/exec" }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  const text = () => page.locator("#view").innerText();
  const sheetJob = no => gas.sheets.Jobs.rows.find(r => r[0] === no);

  page.on("request", r => { if (r.url().includes("token") || r.url().includes(ADMIN_PIN)) errors.push("secret in URL: " + r.url()); });
  // admin creates a storeman login from the office; the storeman signs in on the phone
  assert.ok(gas.post({ action: "users", token: key, cmd: "save", isNew: true, user: { username: "sipho", name: "Sipho M", role: "storeman" }, pin: "5832" }).ok);
  await page.goto("http://localhost:8766/");
  await page.fill("#lg_user", "sipho"); await page.fill("#lg_pin", "5832");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector("text=Choose your PIN");
  await page.fill("#cp_old", "5832"); await page.fill("#cp_new", "7140"); await page.fill("#cp_new2", "7140");
  await page.getByRole("button", { name: "Save my PIN" }).click();
  await page.waitForSelector("text=+ New job");

  // 1. New job: number comes from the Sheet
  await page.getByRole("button", { name: "+ New job" }).click();
  await page.fill("#nj_client", "Botha, Durbanville"); await page.fill("#nj_type", "5 kW rooftop");
  await page.selectOption("#nj_van", "VAN-1"); await page.fill("#nj_inst", "Sipho");
  await page.selectOption("#nl_sku_0", "PV6-RED"); await page.fill("#nl_q_0", "50");
  await page.getByRole("button", { name: "Create job" }).click();
  await page.waitForSelector("text=Job J-1001 created");
  assert.strictEqual(sheetJob("J-1001")[6], "quoted");

  // 2. Kit (55 m) and van collects
  await page.getByText("Kit is packed").click();
  await page.waitForSelector("text=Kit recorded");
  await page.getByRole("button", { name: /collected it/ }).click();
  await page.waitForSelector("text=is on site");
  await page.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("Up to date"));
  assert.strictEqual(sheetJob("J-1001")[6], "out");

  // 3. Signal drops. Crate comes back and the job is closed OFFLINE.
  await context.setOffline(true);
  await page.fill("#ret_ret_PV6-RED", "3"); await page.fill("#ret_used_PV6-RED", "50");
  await page.locator("#ret_used_PV6-RED").blur();
  await page.fill("#ret_reason", "Offcut left on roof");
  await page.getByRole("button", { name: "Close job" }).click();
  await page.waitForSelector("text=Job closed");
  await page.waitForFunction(() => /waiting to sync/.test(document.getElementById("statusText").textContent));
  assert.strictEqual(sheetJob("J-1001")[6], "out", "Sheet not touched while offline");
  assert.ok((await text()).includes("Closed"), "phone already shows it closed");
  await page.screenshot({ path: out + "/live-offline.png" });

  // 4. Still offline: a new job needs the Sheet, so it says so clearly
  await page.getByRole("button", { name: "← Jobs" }).click();
  await page.getByRole("button", { name: "+ New job" }).click();
  await page.fill("#nj_client", "X"); await page.selectOption("#nj_van", "VAN-1"); await page.fill("#nj_inst", "Y");
  await page.selectOption("#nl_sku_0", "MC4"); await page.fill("#nl_q_0", "2");
  await page.getByRole("button", { name: "Create job" }).click();
  await page.waitForSelector("text=This needs signal");

  // 5. Offline: issue extra MC4 to... first top up the van with 8 MC4 (queued)
  await page.locator("nav button[data-tab=scan]").click();
  await page.fill("#sc_code", "GS-0002"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByRole("radio", { name: "Van top-up" }).click();
  await page.fill("#tu_qty", "8"); await page.selectOption("#tu_van", "VAN-1");
  await page.getByRole("button", { name: "Save van top-up" }).click();
  await page.waitForSelector("text=Van topped up");

  // Meanwhile ANOTHER device takes 5 MC4 from the store (only 10 there): phone's 8 no longer fits.
  const other = gas.post({ token: key, ops: [{ op: "append", sheet: "Moves", rows: [{ id: "o1", ts: new Date().toISOString(), type: "topup", sku: "MC4", qty: 5, from: "WH", to: "VAN-1" }] }] });
  assert.ok(other.ok, other.error);

  // 6. Signal returns: the job close syncs, the clashing top-up is refused and explained
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector("text=Not saved");
  assert.ok(/Not enough/.test(await text()));
  await page.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("Up to date"));
  assert.strictEqual(sheetJob("J-1001")[6], "closed");
  assert.strictEqual(sheetJob("J-1001")[11], "37", "2 m missing x R18.50");
  const sheetMoves = gas.sheets.Moves.rows.slice(1);
  assert.strictEqual(sheetMoves.filter(r => r[2] === "topup" && r[3] === "MC4").length, 1, "only the other device's top-up exists");
  await page.screenshot({ path: out + "/live-refused.png" });

  // the movements carry the real login, not a typed name
  assert.ok(gas.sheets.Moves.rows.filter(r => r[7] === "J-1001").every(r => r[15] === "sipho"));
  // 7. Corrections are admin-only: switch to the admin login on the same phone
  await page.locator("nav button[data-tab=more]").click();
  await page.getByRole("button", { name: /My account/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.fill("#lg_user", "admin"); await page.fill("#lg_pin", ADMIN_PIN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector("text=+ New job");
  // Correction: reverse the drum receipt partly? Reverse the 3 m return (job closed -> not allowed), reverse a receive instead.
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: "MC4 connector pair" }).click();
  await page.waitForSelector("text=Movements");
  const revButtons = page.getByRole("button", { name: "Reverse this" });
  assert.ok(await revButtons.count() >= 1);
  // reversing the receipt of 10 would make the store negative (5 already gone) -> refused locally
  await revButtons.last().click();
  await page.fill("#rev_reason", "Wrong delivery");
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.waitForSelector("text=Not enough");
  // reverse the other device's top-up instead -> allowed
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reverse this" }).first().click();
  await page.fill("#rev_reason", "Van didn't take them");
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.waitForSelector("text=Correction recorded");
  await page.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("Up to date"));
  const rev = gas.sheets.Moves.rows.find(r => r[2] === "reverse");
  assert.ok(rev && rev[5] === "VAN-1" && rev[6] === "WH" && rev[16] === "topup");
  await page.screenshot({ path: out + "/live-history.png", fullPage: true });

  // 8. Reload: only new movements are downloaded
  let movesSent = null;
  page.on("request", r => { if (r.method() === "POST") { try { movesSent = JSON.parse(r.postData()).have; } catch (e) {} } });
  await page.reload();
  await page.getByRole("button", { name: "+ New job" }).waitFor();
  await page.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("Up to date"));
  assert.ok(movesSent > 0, "phone only asks for movements it doesn't have");

  assert.deepStrictEqual(errors, [], "no script errors, no key in URLs");
  console.log("live: all checks passed");
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
