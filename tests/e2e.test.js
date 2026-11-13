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
  // sign in as the demo admin
  await page.fill("#lg_user", "admin"); await page.fill("#lg_pin", "000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForSelector("text=Wrong username or PIN");
  await page.fill("#lg_user", "Admin"); await page.fill("#lg_pin", "246810");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForSelector("text=To kit");
  assert.ok((await page.locator("#who").innerText()).includes("Admin"));
  // codes with dots keep their typed values (bug found with real supplier codes)
  assert.deepStrictEqual(await page.evaluate(() => { bindValue("ret.HW-06.0-G.used", "5"); bindValue("cnt.HW-06.0-G", "7"); return [S.f.ret["HW-06.0-G"].used, S.f.cnt["HW-06.0-G"]]; }), ["5", "7"]);
  await page.evaluate(() => { S.f = {}; });
  // Back / Forward / Login page
  assert.ok(await page.locator("#navBack").isDisabled(), "nothing to go back to yet");
  await page.getByText("J-1005").click();
  await page.waitForSelector("text=Pick the kit");
  await page.locator("nav button[data-tab=stock]").click();
  await page.waitForSelector("text=Stock on hand");
  await page.locator("#navBack").click();
  await page.waitForSelector("text=Pick the kit");
  await page.locator("#navBack").click();
  await page.waitForSelector("text=To kit");
  assert.ok(await page.locator("#navBack").isDisabled());
  await page.locator("#navFwd").click();
  await page.waitForSelector("text=Pick the kit");
  await page.goBack();                       // phone/browser back gesture works too
  await page.waitForSelector("text=To kit");
  await page.locator("#navHome").click();
  await page.getByRole("button", { name: "Stay signed in" }).click();
  assert.ok(await page.locator("#homeConfirm").isHidden());
  await page.locator("#navHome").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.waitForSelector("#lg_user");
  assert.ok(await page.locator("#navHome").isHidden(), "on the login page");
  await page.fill("#lg_user", "admin"); await page.fill("#lg_pin", "246810");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
  await page.fill("#sc_code", "gs-0003"); await page.getByRole("button", { name: "Go", exact: true }).click();
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
  await page.fill("#sc_code", "https://x.github.io/app/?c=J-1004"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForSelector("text=Van collects the crate");

  // Stock + counts + stickers render
  await page.locator("nav button[data-tab=stock]").click();
  await page.waitForSelector("text=Stock on hand");
  await page.screenshot({ path: out + "/4-stock.png", fullPage: true });
  await page.getByRole("button", { name: /Missing, last 30 days/ }).click();
  await page.waitForSelector("text=Where it sits");
  const st = await text();
  assert.ok(st.includes("Sipho") && st.includes("Jobs that used more than quoted") && st.includes("Jobs closed with missing stock"));
  await page.screenshot({ path: out + "/4b-report.png", fullPage: true });
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

  // --- roles in the demo ---
  async function signInAs(u, pin) {
    await page.locator("nav button[data-tab=more]").click();
    await page.getByRole("button", { name: /My account/ }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.fill("#lg_user", u); await page.fill("#lg_pin", pin);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("nav.tabs").waitFor();
  }
  // admin adds a storeman login; the new person must choose their own PIN
  await page.locator("nav button[data-tab=more]").click();
  assert.strictEqual((await page.locator("nav button[data-tab=more]").innerText()).trim(), "Admin");
  await page.getByRole("button", { name: /Logins/ }).click();
  await page.fill("#us_name", "Thabo Nkosi"); await page.fill("#us_user", "thabo"); await page.fill("#us_pin", "5281");
  await page.getByRole("button", { name: "Add login" }).click();
  await page.waitForSelector("text=Temporary PIN for Thabo Nkosi");
  await page.screenshot({ path: out + "/7-logins.png", fullPage: true });
  await page.getByRole("button", { name: "← Admin" }).click();
  await page.getByRole("button", { name: /My account/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.fill("#lg_user", "thabo"); await page.fill("#lg_pin", "5281");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForSelector("text=Choose your PIN");
  assert.ok(await page.locator("nav.tabs").isHidden(), "no app until PIN chosen");
  assert.strictEqual(await page.locator("#cp_old").count(), 0, "temporary PIN not asked twice"); await page.fill("#cp_new", "1234"); await page.fill("#cp_new2", "1234");
  await page.getByRole("button", { name: "Save my PIN" }).click();
  await page.waitForSelector("text=simple run");
  await page.fill("#cp_new", "7319"); await page.fill("#cp_new2", "7319");
  await page.getByRole("button", { name: "Save my PIN" }).click();
  await page.getByRole("button", { name: "+ New job" }).waitFor();
  // storeman: works, but no admin section and no corrections
  assert.strictEqual((await page.locator("nav button[data-tab=more]").innerText()).trim(), "More");
  assert.ok(await page.locator("nav button[data-tab=scan]").isVisible());
  await page.locator("nav button[data-tab=stock]").click();
  assert.ok(!(await text()).includes("Missing, last 30 days"), "storeman doesn't see the missing-stock report");
  await page.getByRole("button", { name: "PV cable 6 mm² red" }).click();
  await page.waitForSelector("text=Movements");
  // v1.13: a User can ask for a correction, but nothing is saved until a manager types their own username and PIN
  assert.ok(await page.getByRole("button", { name: "Reverse this" }).count() > 0, "storeman can ask for a correction");
  await page.getByRole("button", { name: "Reverse this" }).first().click();
  await page.fill("#rev_reason", "Just checking");
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.locator("#ovModal").waitFor({ state: "visible" });
  assert.strictEqual(await page.evaluate(() => D.Moves.filter(m => m.type === "reverse").length), 0, "no correction without a manager");
  await page.locator("#ovCancel").click();
  await page.locator("#ovModal").waitFor({ state: "hidden" });
  assert.strictEqual(await page.evaluate(() => D.Moves.filter(m => m.type === "reverse").length), 0);
  await page.evaluate(() => { S.f = {}; });
  // viewer: look only
  await signInAs("owner", "8642");
  assert.ok(await page.locator("nav button[data-tab=scan]").isHidden());
  assert.ok(await page.locator("nav button[data-tab=counts]").isHidden());
  assert.strictEqual(await page.getByRole("button", { name: "+ New job" }).count(), 0);
  await page.getByText("J-1003").click();
  await page.waitForSelector("text=View only");
  await page.locator("nav button[data-tab=more]").click();
  await page.getByRole("button", { name: /Missing stock report/ }).click();
  await page.waitForSelector("text=Where it sits");
  await page.screenshot({ path: out + "/8-viewer-report.png", fullPage: true });
  // --- stock out (v1.12): User sipho takes a 2-line load out to Customer / other ---
  await signInAs("sipho", "1357");
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: /Take stock out/ }).click();
  await page.waitForSelector("text=Items going out");
  const soBefore = await page.evaluate(() => [C.bal(X.B, "WH", "PV6-RED"), C.bal(X.B, "WH", "MC4")]);
  await page.selectOption("#so_add", "PV6-RED");
  await page.fill("#so_code", "mc4"); await page.getByRole("button", { name: "Add", exact: true }).click();
  assert.strictEqual(await page.locator("[id^=so_qty_]").count(), 2, "two lines");
  await page.fill("#so_qty_0", "5"); await page.fill("#so_qty_1", "999");
  await page.selectOption("#so_dest", "other");
  await page.fill("#so_by", "Test Driver"); await page.fill("#so_ref", "DN-TEST-1");
  await page.getByRole("button", { name: "Save stock out" }).click();
  await page.waitForSelector(".msg.err");
  assert.ok((await text()).includes("Only") && (await text()).includes("MC4"), "over-quantity blocked, item named");
  await page.fill("#so_qty_1", "0");
  await page.getByRole("button", { name: "Save stock out" }).click();
  await page.waitForSelector("text=above zero");
  await page.fill("#so_qty_1", "7");
  // the draft survives switching tabs
  await page.locator("nav button[data-tab=jobs]").click();
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: /Take stock out \(2 on the list\)/ }).click();
  assert.strictEqual(await page.inputValue("#so_qty_1"), "7");
  await page.getByRole("button", { name: "Save stock out" }).click();
  await page.waitForSelector("text=Stock out saved: 2 line(s).");
  assert.deepStrictEqual(await page.evaluate(() => [C.bal(X.B, "WH", "PV6-RED"), C.bal(X.B, "WH", "MC4"), C.bal(X.B, "OUT", "MC4")]), [soBefore[0] - 5, soBefore[1] - 7, 7]);
  assert.strictEqual(await page.locator("[id^=so_qty_]").count(), 0, "list cleared after save");
  const rec = await text();
  assert.ok(rec.includes("Recent stock out") && rec.includes("Customer / other") && rec.includes("DN-TEST-1") && rec.includes("Test Driver"), "record shows the load");
  assert.ok(!/R\u00a0\d/.test(rec.split("Recent stock out")[1]), "no rand values for a User");
  assert.deepStrictEqual(await page.evaluate(() => { const m = D.Moves.filter(x => x.type === "out"); return [m.length, m[0].ts === m[1].ts, m[0].from, m[0].to, m[0].installer, m[0].ref, m[0].value === C.round2(m[0].qty * m[0].unitCost)]; }), [2, true, "WH", "OUT", "Test Driver", "DN-TEST-1", true]);
  // Scan tab: 4th mode adds the item to the list and opens the Stock out screen
  await page.locator("nav button[data-tab=scan]").click();
  await page.locator("#camStop").click().catch(() => {});
  await page.fill("#sc_code", "gs-0001"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByRole("radio", { name: "Stock out" }).click();
  await page.waitForSelector("text=Items going out");
  assert.strictEqual(await page.locator("[id^=so_qty_]").count(), 1);
  await page.getByRole("button", { name: /Remove/ }).click();
  // viewer: sees the record, cannot save
  await signInAs("owner", "8642");
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: "Stock out record" }).click();
  await page.waitForSelector("text=Recent stock out");
  assert.strictEqual(await page.getByRole("button", { name: "Save stock out" }).count(), 0, "viewer has no save button");
  assert.ok(!/R\u00a0\d/.test((await text()).split("Recent stock out")[1]), "no rand values for a Viewer");
  const vErr = await page.evaluate(() => { S.out = { lines: [{ sku: "MC4", qty: "1" }], dest: "other", van: "", job: "", by: "x", ref: "y", note: "" }; A.outSave(); return S.msg && S.msg.t; });
  assert.ok(/view only/i.test(vErr), "viewer save refused");
  await page.evaluate(() => { S.out = null; });
  // manager sees rand values and can reverse
  await signInAs("lebo", "580214");
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: /Take stock out/ }).click();
  assert.ok(/R\u00a0\d/.test((await text()).split("Recent stock out")[1]), "manager sees rand values");
  await page.getByRole("button", { name: "← Stock" }).click();
  await page.getByRole("button", { name: "MC4 connector" }).first().click();
  await page.waitForSelector("text=Movements");
  assert.ok((await text()).includes("Stock out"), "item history labels the move");
  await page.getByRole("button", { name: "Reverse this" }).first().click();
  await page.fill("#rev_reason", "Wrong item");
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.waitForSelector("text=Correction recorded");
  assert.strictEqual(await page.evaluate(() => C.bal(X.B, "WH", "MC4")), soBefore[1], "reversal returns it to the store");
  // --- manager override (v1.13): a User needs a manager's own username and PIN for corrections and count decisions ---
  await signInAs("sipho", "1357");
  const redWh = await page.evaluate(() => C.bal(X.B, "WH", "PV6-RED"));
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: /PV cable 6 mm² red/ }).first().click();
  await page.waitForSelector("text=Movements");
  await page.getByRole("button", { name: "Reverse this" }).first().click();   // newest movement = sipho's stock out of 5 m
  await page.fill("#rev_reason", "Wrong load");
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.locator("#ovModal").waitFor({ state: "visible" });
  assert.ok((await page.locator("#ovSummary").innerText()).includes("Stock out"), "pop-up says what is being approved");
  assert.strictEqual(await page.getAttribute("#ov_pin", "type"), "password");
  assert.strictEqual(await page.getAttribute("#ov_pin", "inputmode"), "numeric");
  assert.strictEqual(await page.getAttribute("#ov_pin", "autocomplete"), "off");
  assert.strictEqual(await page.evaluate(() => D.Moves.filter(m => m.type === "reverse" && m.by === "sipho").length), 0, "nothing saved before approval");
  // Escape closes and clears; Cancel too
  await page.fill("#ov_user", "lebo"); await page.fill("#ov_pin", "580214");
  await page.keyboard.press("Escape");
  await page.locator("#ovModal").waitFor({ state: "hidden" });
  assert.deepStrictEqual(await page.evaluate(() => [$("#ov_user").value, $("#ov_pin").value, OV]), ["", "", null], "Escape clears the fields");
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.locator("#ovModal").waitFor({ state: "visible" });
  await page.fill("#ov_user", "lebo"); await page.fill("#ov_pin", "580214");
  await page.locator("#ovCancel").click();
  await page.locator("#ovModal").waitFor({ state: "hidden" });
  assert.strictEqual(await page.evaluate(() => $("#ov_pin").value), "");
  // wrong PIN: error in the pop-up, stays open, PIN field cleared
  await page.getByRole("button", { name: "Confirm correction" }).click();
  await page.fill("#ov_user", "lebo"); await page.fill("#ov_pin", "111222");
  await page.locator("#ovOk").click();
  await page.waitForFunction(() => /Manager username or PIN is wrong/.test(document.getElementById("ovErr").textContent));
  assert.ok(await page.locator("#ovModal").isVisible(), "pop-up stays open");
  assert.strictEqual(await page.inputValue("#ov_pin"), "", "PIN field cleared after a refusal");
  // the signed-in User can't approve their own correction, and a User/Viewer can't approve either
  for (const [u, p, re] of [["sipho", "1357", /other than you/], ["owner", "8642", /other than you/]]) {
    await page.fill("#ov_user", u); await page.fill("#ov_pin", p); await page.keyboard.press("Enter");
    await page.waitForFunction(r => new RegExp(r).test(document.getElementById("ovErr").textContent), re.source);
  }
  assert.strictEqual(await page.evaluate(() => D.Moves.filter(m => m.type === "reverse" && m.by === "sipho").length), 0, "still nothing saved");
  // right PIN, Enter submits
  await page.fill("#ov_user", "lebo"); await page.fill("#ov_pin", "580214"); await page.keyboard.press("Enter");
  await page.waitForSelector("text=Approved by Lebo (warehouse manager). Correction recorded.");
  await page.locator("#ovModal").waitFor({ state: "hidden" });
  assert.strictEqual(await page.evaluate(() => $("#ov_pin").value + $("#ov_user").value), "", "fields cleared on success");
  assert.strictEqual(await page.evaluate(() => C.bal(X.B, "WH", "PV6-RED")), redWh + 5, "the correction returned the 5 m to the store");
  assert.deepStrictEqual(await page.evaluate(() => { const m = D.Moves.filter(x => x.type === "reverse" && x.by === "sipho"); return [m.length, m[0].approvedBy, m[0].reason]; }), [1, "lebo", "Wrong load"]);
  assert.ok((await text()).includes("approved by lebo"), "history shows who approved");
  // a User counts the store shelves; it appears under "Waiting for approval" in the Counts tab
  const lugSys = await page.evaluate(() => C.bal(X.B, "WH", "LUG-16"));
  await page.locator("nav button[data-tab=counts]").click();
  await page.locator("#cnt_LUG-16").fill(String(lugSys - 2)); await page.locator("#cnt_LUG-16").blur();
  await page.getByRole("button", { name: "Submit count for approval" }).click();
  await page.waitForSelector("text=Count submitted");
  assert.ok((await text()).includes("Waiting for approval"));
  const waitingBefore = await page.getByRole("button", { name: "Approve", exact: true }).count();
  assert.ok(waitingBefore >= 2, "the waiting counts have Approve buttons for a User");
  const myCount = () => page.evaluate(() => D.Counts.filter(c => c.status === "pending" && c.lines.includes("LUG-16"))[0].id);
  await page.locator('button[data-action=approveCount][data-id="' + await myCount() + '"]').click();
  await page.locator("#ovModal").waitFor({ state: "visible" });
  assert.ok((await page.locator("#ovSummary").innerText()).includes("store shelves"));
  await page.fill("#ov_user", "lebo"); await page.fill("#ov_pin", "580214"); await page.locator("#ovOk").click();
  await page.waitForSelector("text=Count approved by Lebo (warehouse manager).");
  assert.deepStrictEqual(await page.evaluate(() => { const c = D.Counts.filter(x => x.by === "sipho" && x.status === "approved"); const m = D.Moves.filter(x => x.type === "countshort" && x.sku === "LUG-16" && x.ref === c[0].id); return [c.length, c[0].decidedBy, m.length, m[0].by, m[0].approvedBy, m[0].ref === c[0].id]; }), [1, "lebo", 1, "sipho", "lebo", true], "decidedBy is the manager; the adjustment shows both people");
  assert.strictEqual(await page.evaluate(() => C.bal(X.B, "WH", "LUG-16")), lugSys - 2);
  // reject needs a reason, then the pop-up
  await page.locator("#cnt_LUG-16").fill(String(lugSys + 5)); await page.locator("#cnt_LUG-16").blur();
  await page.getByRole("button", { name: "Submit count for approval" }).click();
  await page.waitForSelector("text=Count submitted");
  const rejId = await myCount();
  await page.locator('button[data-action=rejStart][data-id="' + rejId + '"]').click();
  await page.getByRole("button", { name: "Reject count" }).click();
  await page.waitForSelector("text=Give a reason");
  assert.ok(await page.locator("#ovModal").isHidden(), "no pop-up until there is a reason");
  await page.locator("#rej_" + rejId).fill("Recount please");
  await page.getByRole("button", { name: "Reject count" }).click();
  await page.locator("#ovModal").waitFor({ state: "visible" });
  await page.fill("#ov_user", "admin"); await page.fill("#ov_pin", "246810"); await page.locator("#ovOk").click();
  await page.waitForSelector("text=Count rejected by Kyle (senior admin).");
  assert.deepStrictEqual(await page.evaluate(() => { const c = D.Counts.filter(x => x.status === "rejected"); return [c.length, c[0].decidedBy, c[0].decisionNote]; }), [1, "admin", "Recount please"]);
  // nothing sensitive stayed on the phone. (The demo's pretend Users tab, sc_demo_users, is the one place demo PINs live, like the Sheet's Users tab.)
  const stored = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
  for (const [k, v] of Object.entries(stored)) {
    assert.ok(!/override/i.test(v), "no 'override' in localStorage " + k);
    assert.ok(!v.includes("111222"), "a wrong PIN is never stored: " + k);
    if (k !== "sc_demo_users") assert.ok(!v.includes("580214") && !v.includes("246810"), "manager PIN not in localStorage " + k);
  }
  assert.ok(!(await page.evaluate(() => JSON.stringify([S, cfg, Q, D.Moves.slice(-5)]))).match(/580214|246810|111222/), "no manager PIN in app state, config or queue");
  // a Viewer sees no reverse or approve at all
  await signInAs("owner", "8642");
  await page.locator("nav button[data-tab=stock]").click();
  await page.getByRole("button", { name: /PV cable 6 mm² red/ }).first().click();
  await page.waitForSelector("text=Movements");
  assert.strictEqual(await page.getByRole("button", { name: "Reverse this" }).count(), 0, "viewer can't reverse");
  assert.strictEqual(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
  // --- inventory: User submits a count, Warehouse Manager approves ---
  await signInAs("sipho", "1357");
  await page.locator("nav button[data-tab=counts]").click();
  await page.fill("#cnt_flt", "black");
  assert.ok(!(await page.locator("#view .tablewrap").first().innerText()).includes("MC4 connector"), "search filters the list (the count form; waiting counts below keep their own tables)");
  await page.locator("#cnt_PV6-BLK").fill("300"); await page.locator("#cnt_PV6-BLK").blur();
  await page.waitForSelector("text=short");
  await page.fill("#cnt_note", "Recounted twice");
  await page.getByRole("button", { name: "Submit count for approval" }).click();
  await page.waitForSelector("text=Count submitted");
  await signInAs("lebo", "580214");
  assert.strictEqual((await page.locator("nav button[data-tab=more]").innerText()).trim(), "Manage");
  await page.locator("nav button[data-tab=more]").click();
  assert.strictEqual(await page.getByRole("button", { name: /Logins/ }).count(), 0, "managers don't manage logins");
  await page.getByRole("button", { name: /Inventory/ }).click();
  await page.waitForSelector("text=Counted by");
  await page.screenshot({ path: out + "/9-approve.png", fullPage: true });
  const blackBefore = await page.evaluate(() => C.bal(X.B, "WH", "PV6-BLK"));
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.waitForSelector("text=Count approved");
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.waitForSelector("text=Count approved");
  assert.strictEqual(await page.evaluate(() => C.bal(X.B, "WH", "PV6-BLK")), 300, "approved count sets store stock");
  assert.notStrictEqual(blackBefore, 300);
  // manager's own count can't be self-approved (submit as manager goes direct, so test via a User count rejected)
  // adjust: write off 6 m damaged
  await page.getByRole("tab", { name: "Adjust" }).click();
  await page.selectOption("#adj_sku", "PV6-RED"); await page.fill("#adj_qty", "6");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await page.waitForSelector("text=Add the details");
  await page.fill("#adj_note", "Crushed by forklift");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await page.waitForSelector("text=Adjustment saved");
  // import: set counts from Excel paste incl. a new item
  await page.getByRole("tab", { name: "Import / export" }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download stock list (CSV)" }).click();
  const file = await dl;
  const csv = fs.readFileSync(await file.path(), "utf8");
  assert.ok(csv.includes("Item code,Store qty,Landed cost") && csv.includes("PV6-RED"));
  await page.fill("#imp_text", "Code\tQty\tCost\tName\tUnit\nMC4\t50\t30\nBRK-32A\t12\t95\tBreaker 32 A\tea\nbad code\t1");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForSelector("text=is a new item");
  assert.strictEqual(await page.getByRole("button", { name: /^Apply/ }).count(), 0, "nothing applies while a line is wrong");
  await page.fill("#imp_text", "Code\tQty\tCost\tName\tUnit\nMC4\t50\t30\nBRK-32A\t12\t95\tBreaker 32 A\tea");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForSelector("text=New item");
  await page.screenshot({ path: out + "/10-import.png", fullPage: true });
  await page.getByRole("button", { name: "Apply 2 line(s)" }).click();
  await page.waitForSelector("text=Imported 2 line(s), 1 new item(s)");
  assert.deepStrictEqual(await page.evaluate(() => [C.bal(X.B, "WH", "MC4"), C.bal(X.B, "WH", "BRK-32A"), X.items["MC4"].cost, X.items["BRK-32A"].cost]), [50, 12, 30, 95]);
  // receive mode: opening stock adds on top
  await page.getByRole("radio", { name: /Add as received/ }).click();
  await page.fill("#imp_ref", "Test supplier INV-1");
  await page.fill("#imp_text", "BRK-32A,8,105");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Apply 1 line(s)" }).click();
  await page.waitForSelector("text=Imported 1 line(s)");
  assert.deepStrictEqual(await page.evaluate(() => [C.bal(X.B, "WH", "BRK-32A"), X.items["BRK-32A"].cost]), [20, 99], "12 at R95 + 8 at R105 = R99 average");
  // units: new items default to metres, inches available
  await page.getByRole("button", { name: "← Manage" }).click();
  await page.getByRole("button", { name: /^Items/ }).click();
  assert.strictEqual(await page.inputValue("#it_uom"), "m", "metres by default");
  assert.deepStrictEqual(await page.locator("#it_uom option").allInnerTexts(), ["Metres (length)", "Inches (length)", "Units (count)"]);
  await page.fill("#it_sku", "conduit 20mm"); await page.fill("#it_name", "Conduit 20 mm"); await page.selectOption("#it_uom", "in");
  await page.getByRole("button", { name: "Add item" }).click();
  await page.waitForSelector("text=Added CONDUIT-20MM");
  assert.ok((await text()).includes("inches"));
  await page.locator("nav button[data-tab=scan]").click();
  await page.fill("#sc_code", "conduit 20mm"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForSelector("text=Quantity (in)");
  assert.ok((await text()).includes("excl. VAT"));
  // the User can't use inventory, and the admin sees the role choices
  await signInAs("admin", "246810");
  await page.locator("nav button[data-tab=more]").click();
  await page.getByRole("button", { name: /Logins/ }).click();
  const opts = await page.locator("#us_role option").allInnerTexts();
  assert.deepStrictEqual(opts, ["User", "Warehouse Manager", "Senior Admin", "Viewer"]);

  // Start empty + choose file (made-up data)
  await page.locator("nav button[data-tab=more]").click();
  await page.getByRole("button", { name: /My account/ }).click();
  await page.getByRole("button", { name: "Start empty" }).click();
  await page.getByRole("button", { name: /Tap again/ }).click();
  await page.waitForSelector("text=All stock, items, jobs, stickers and counts cleared");
  assert.deepStrictEqual(await page.evaluate(() => [D.Items.length, D.Jobs.length, D.Moves.length, D.Labels.length, D.Counts.length, D.Vans.length]), [0, 0, 0, 0, 0, 2]);
  const tmp = require("os").tmpdir() + "/Test-Supplier-INV100.csv";
  fs.writeFileSync(tmp, "\ufeffItem code,Description,Quantity,Total Ex Vat,Unit\nTEST A1,Test cable,50,500.00,m\nTEST B2,Test breaker,4,400.00,ea\n");
  await page.setInputFiles("#imp_file", tmp);
  await page.waitForSelector("text=Total value");
  assert.strictEqual(await page.inputValue("#imp_ref"), "Test Supplier INV100");
  await page.getByRole("button", { name: "Apply 2 line(s)" }).click();
  await page.waitForSelector("text=Imported 2 line(s), 2 new item(s)");
  assert.deepStrictEqual(await page.evaluate(() => [D.Items.length, C.bal(X.B, "WH", "TEST-A1"), X.items["TEST-A1"].uom, X.items["TEST-B2"].cost]), [2, 50, "m", 100]);

  // Enter key signs in; wrong PIN is rejected; reset link clears demo data after confirmation
  await page.goto("http://localhost:8765/?reset=demo-empty");
  await page.waitForSelector("text=Clear and start empty?");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.locator("nav.tabs").waitFor();
  assert.ok((await page.evaluate(() => D.Items.length)) === 2, "cancel leaves data alone");
  await page.goto("http://localhost:8765/?reset=demo-empty");
  await page.getByRole("button", { name: "Yes, clear and start empty" }).click();
  await page.waitForSelector("text=Cleared. Sign in as admin");
  assert.strictEqual(await page.inputValue("#lg_user"), "admin");
  assert.ok(!page.url().includes("reset"), "link removed from the address so a refresh doesn't clear again");
  await page.locator("#lg_pin").fill("111111"); await page.locator("#lg_pin").press("Enter");
  await page.waitForSelector("text=Wrong username or PIN");
  await page.locator("#lg_user").fill("ADMIN "); await page.locator("#lg_user").press("Enter");
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), "lg_pin", "Enter on username moves to PIN when PIN is empty");
  await page.locator("#lg_pin").fill("246810"); await page.locator("#lg_pin").press("Enter");
  await page.getByRole("button", { name: "+ New job" }).waitFor();
  assert.deepStrictEqual(await page.evaluate(() => [D.Items.length, D.Jobs.length, D.Moves.length, D.Vans.length]), [0, 0, 0, 2]);
  // reset demo logins from the sign-in page
  await page.evaluate(() => { var u = LS.get("sc_demo_users", null) || demo.users(); u.find(x => x.username === "admin").pin = "999999"; LS.set("sc_demo_users", u); });
  await page.locator("#navHome").click(); await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.locator("#lg_user").fill("admin"); await page.locator("#lg_pin").fill("246810"); await page.locator("#lg_pin").press("Enter");
  await page.waitForSelector("text=Wrong username or PIN");
  await page.getByRole("button", { name: "Can't sign in? Reset demo logins" }).click();
  await page.locator("#lg_pin").fill("246810"); await page.locator("#lg_pin").press("Enter");
  await page.getByRole("button", { name: "+ New job" }).waitFor();
  assert.strictEqual(await page.evaluate(() => D.Items.length), 0, "resetting logins kept the data");
  // example data link
  await page.goto("http://localhost:8765/?reset=demo-example");
  await page.getByRole("button", { name: "Yes, load example data" }).click();
  await page.locator("#lg_pin").fill("246810"); await page.locator("#lg_pin").press("Enter");
  await page.getByRole("button", { name: "+ New job" }).waitFor();
  assert.ok((await page.evaluate(() => D.Items.length)) > 5);

  // dev one-tap sign-in (demo): a button per role
  await page.locator("#navHome").click(); await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.getByRole("button", { name: "⚡ Warehouse Manager" }).click();
  await page.getByRole("button", { name: "+ New job" }).waitFor();
  assert.ok((await page.locator("#who").innerText()).includes("Warehouse Manager"));
  assert.ok((await page.locator("#ver").innerText()).includes("DEV"));
  await page.locator("#navHome").click(); await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page.getByRole("button", { name: "⚡ Senior Admin" }).click();
  await page.getByRole("button", { name: "+ New job" }).waitFor();

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
