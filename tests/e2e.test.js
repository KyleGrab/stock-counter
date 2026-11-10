// End-to-end run of the phone app in demo mode, in a headless phone-sized browser.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const assert = require("assert");
const root = path.join(__dirname, "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": types[path.extname(p)] || "text/plain" }); res.end(b); });
});

(async () => {
  await new Promise(r => server.listen(8765, r));
  const out = process.argv[2] || "/tmp";
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|fonts/.test(m.text())) errors.push(m.text()); });
  const text = () => page.locator("#view").innerText();

  await page.goto("http://localhost:8765/");
  await page.getByText("Try it with example data").click();
  await page.waitForSelector("text=To kit");
  assert.ok((await text()).includes("J-1005"));
  await page.screenshot({ path: out + "/1-jobs.png", fullPage: true });

  // Kit J-1005: cable + 2 panels + 1 inverter (serials typed in)
  await page.getByText("J-1005").click();
  await page.waitForSelector("text=Pick the kit");
  assert.strictEqual(await page.inputValue("#kit_PV6-RED"), "28", "25 m + 10% allowance, rounded up");
  await page.getByText("Kit is packed").click();
  await page.waitForSelector(".msg.err");
  assert.ok((await text()).includes("serial numbers"));
  await page.getByRole("button", { name: /Scan serials \(0\/2\)/ }).click();
  await page.waitForSelector("#ser_manual");
  for (const s of ["JA550-24-0023", "JA550-24-0024"]) { await page.fill("#ser_manual", s); await page.getByRole("button", { name: "Add", exact: true }).click(); }
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: /Scan serials \(0\/1\)/ }).click();
  await page.waitForSelector("#ser_manual");
  // wrong serial: one already on job J-1001
  await page.fill("#ser_manual", "SN5K-A0191"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Kit is packed").click();
  await page.waitForSelector("text=is not in the store");
  // fix it
  await page.getByRole("button", { name: /Scan serials \(1\/1\)/ }).click();
  await page.waitForSelector("#ser_manual");
  await page.evaluate(() => { S.f.serials["INV-5KW"] = []; });
  await page.fill("#ser_manual", "SN5K-A0193"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Kit is packed").click();
  await page.waitForSelector("text=Kit recorded");
  await page.screenshot({ path: out + "/2-crate.png", fullPage: true });
  await page.getByRole("button", { name: /collected it/ }).click();
  await page.waitForSelector("text=is on site");

  // Return check on J-1005: 28 m red out. 2 back, 0.5 scrap, 24 used -> 1.5 m missing
  await page.fill("#ret_ret_PV6-RED", "2"); await page.fill("#ret_scrap_PV6-RED", "0.5"); await page.fill("#ret_used_PV6-RED", "24");
  await page.fill("#ret_used_PV6-BLK", "28"); await page.fill("#ret_used_PNL-550", "2"); await page.fill("#ret_used_INV-5KW", "1");
  await page.locator("#ret_used_INV-5KW").blur();
  await page.waitForSelector("#retReasonBox:not([hidden])");
  await page.screenshot({ path: out + "/3-return.png", fullPage: true });
  await page.getByRole("button", { name: "Close job" }).click();
  await page.waitForSelector("text=Give a reason");
  await page.fill("#ret_reason", "Offcut left in roof space");
  await page.getByRole("button", { name: "Close job" }).click();
  await page.waitForSelector("text=recorded as missing");
  assert.ok((await text()).includes("R 28 missing"), "1.5 m x R18.50 = R28");

  // Extra stock flow from a scanned sticker (typed)
  await page.getByRole("button", { name: "← Jobs" }).click();
  await page.locator("nav button[data-tab=scan]").click();
  await page.locator("#camStop").click().catch(() => {});
  await page.fill("#sc_code", "gs-0003"); await page.getByRole("button", { name: "Go" }).click();
  await page.waitForSelector("text=AC cable 4 mm² 3-core");
  await page.getByRole("radio", { name: "Extra to job" }).click();
  await page.fill("#ex_qty", "3"); await page.selectOption("#ex_job", "J-1003");
  await page.getByRole("button", { name: "Save extra to job" }).click();
  await page.waitForSelector("text=Give a reason");
  await page.fill("#ex_reason", "Extra run to garage");
  await page.getByRole("button", { name: "Save extra to job" }).click();
  await page.waitForSelector("text=Extra issued");

  // Receive with landed cost -> average cost moves
  await page.getByRole("radio", { name: "Receive" }).click();
  await page.fill("#rc_qty", "100"); await page.fill("#rc_cost", "45"); await page.fill("#rc_ref", "INV-889");
  await page.getByRole("button", { name: "Save receive" }).click();
  await page.waitForSelector("text=Received 100");

  // Crate scan by link opens the job
  await page.fill("#sc_code", "https://x.github.io/app/?c=J-1004"); await page.getByRole("button", { name: "Go" }).click();
  await page.waitForSelector("text=Van collects the crate");

  // Stock + counts + stickers render
  await page.locator("nav button[data-tab=stock]").click();
  await page.waitForSelector("text=Where the missing stock sits");
  const st = await text();
  assert.ok(st.includes("Sipho") && st.includes("Jobs that used more than quoted"));
  await page.screenshot({ path: out + "/4-stock.png", fullPage: true });
  await page.locator("nav button[data-tab=counts]").click();
  await page.selectOption("#cnt_place", "VAN-1");
  await page.fill("#cnt_MC4", "5"); await page.fill("#cnt_TIES-100", "2"); await page.fill("#cnt_LUG-16", "10"); await page.fill("#cnt_FUSE-DC", "4");
  await page.locator("#cnt_FUSE-DC").blur();
  await page.getByRole("button", { name: "Save count" }).click();
  await page.waitForSelector("text=Van count saved");
  await page.locator("nav button[data-tab=more]").click();
  await page.getByText("Stickers", { exact: true }).click();
  await page.waitForSelector(".lbl img");
  await page.screenshot({ path: out + "/5-stickers.png", fullPage: true });

  // Opening a sticker link straight from the phone camera
  await page.goto("http://localhost:8765/?c=GS-0001");
  await page.waitForSelector("text=PV cable 6 mm² red");

  // dark mode renders
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("nav button[data-tab=jobs]").click();
  await page.screenshot({ path: out + "/6-dark.png", fullPage: false });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.ok(!overflow, "no sideways scroll on phone width");
  assert.deepStrictEqual(errors, [], "no script errors");
  console.log("e2e: all checks passed");
  await browser.close(); server.close();
})().catch(async e => { console.error(e); process.exit(1); });
