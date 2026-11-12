// Runs Code.gs against a fake Google Sheet, to check the backend rules without Google.
const assert = require("assert");
const { makeGas } = require("./fake-gas");
const { sheets, cache, adminPin, post, get } = makeGas();

// --- logins ---
assert.ok(/^\d{6}$/.test(adminPin), "setup makes a 6-digit first admin PIN");
assert.strictEqual(sheets.Users.rows[1][0], "admin");
assert.ok(!sheets.Users.rows[1].includes(adminPin), "PIN is never stored in readable form");

const hello = get();
assert.ok(/connection link/.test(hello) && !/pinHash|salt/.test(hello), "GET shows a friendly page and no data");

assert.strictEqual(post({ action: "sync" }).signIn, true, "no token -> sign in");
assert.strictEqual(post({ action: "sync", token: "made-up" }).signIn, true);
let r = post({ action: "login", username: "Admin ", pin: "000000" });
assert.strictEqual(r.ok, false); assert.ok(/Wrong username or PIN/.test(r.error));
r = post({ action: "login", username: " ADMIN", pin: adminPin });
assert.ok(r.ok, r.error); assert.strictEqual(r.user.mustChange, true);
let T = r.token;
assert.ok(post({ action: "sync", token: T }).signIn, "must choose own PIN before anything else");
assert.ok(/simple run/.test(post({ action: "changePin", token: T, oldPin: adminPin, newPin: "123456" }).error), "weak PIN refused");
assert.ok(/6 to 8/.test(post({ action: "changePin", token: T, oldPin: adminPin, newPin: "4821" }).error), "admin PIN 6+");
assert.ok(post({ action: "changePin", token: T, oldPin: adminPin, newPin: "482915" }).ok);
const ADMIN_PIN = "482915";
assert.ok(post({ action: "sync", token: T }).ok, "admin can now sync");
assert.ok(Array.isArray(post({ action: "sync", token: T }).data.Users), "admin sees the user list");
assert.ok(!JSON.stringify(post({ action: "sync", token: T })).includes("pinHash"), "hashes never leave the Sheet");

// lockout after 5 wrong PINs
for (let i = 0; i < 5; i++) post({ action: "login", username: "admin", pin: "999999" });
r = post({ action: "login", username: "admin", pin: ADMIN_PIN });
assert.ok(/locked/.test(r.error), "locked after 5 tries");
Object.keys(cache).filter(k => k.startsWith("fail_")).forEach(k => delete cache[k]);  // 15 minutes later
assert.ok(post({ action: "login", username: "admin", pin: ADMIN_PIN }).ok);

// admin creates a storeman and a viewer
r = post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "sipho", name: "Sipho M", role: "storeman" }, pin: "5832" });
assert.ok(r.ok, r.error);
assert.ok(post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "owner", name: "Owner", role: "viewer" }, pin: "7391" }).ok);
assert.ok(/taken/.test(post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "sipho", name: "X", role: "viewer" }, pin: "7391" }).error));
assert.ok(/at least one active admin|own admin/.test(post({ action: "users", token: T, cmd: "save", isNew: false, user: { username: "admin", name: "Admin", role: "storeman" } }).error));
function signIn(u, pin, newPin) {
  let x = post({ action: "login", username: u, pin });
  assert.ok(x.ok, x.error);
  if (x.user.mustChange) assert.ok(post({ action: "changePin", token: x.token, oldPin: pin, newPin }).ok);
  return x.token;
}
const TS = signIn("sipho", "5832", "7140");
const TV = signIn("owner", "7391", "2864");
assert.ok(/Only a Senior Admin/.test(post({ action: "users", token: TS, cmd: "save", isNew: true, user: { username: "x", name: "x", role: "admin" }, pin: "123123" }).error));
assert.strictEqual(post({ action: "sync", token: TS }).data.Users, undefined, "storeman doesn't see users");

// --- data rules (as admin unless noted) ---
const key = T;
// items: upsert, then merge one field
r = post({ token: key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "PV red", uom: "m", track: "qty", cost: 18.5 }] }] });
assert.ok(r.ok, r.error);
r = post({ token: key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", cost: 19 }] }] });
assert.strictEqual(r.data.Items[0].name, "PV red", "merge keeps other fields");

// the Sheet hands out job numbers, and placeholders are filled in later ops
r = post({ token: key, ops: [
  { op: "create", sheet: "Jobs", ref: "$JOB", row: { client: "A", status: "quoted" } },
  { op: "replaceLines", sheet: "Lines", job: "$JOB", rows: [{ id: "$JOB|PV", job: "$JOB", sku: "PV", quoted: 30 }] }] });
assert.ok(r.ok, r.error);
assert.strictEqual(r.assigned.$JOB, "J-1001");
assert.strictEqual(r.data.Lines[0].id, "J-1001|PV");
r = post({ token: key, ops: [{ op: "create", sheet: "Jobs", ref: "$JOB", row: { client: "B", status: "quoted" } }] });
assert.strictEqual(r.assigned.$JOB, "J-1002", "second job gets the next number, never a clash");
r = post({ token: key, ops: [{ op: "create", sheet: "Labels", ref: "$L", row: { sku: "PV" } }, { op: "create", sheet: "Labels", ref: "$L2", row: { sku: "PV" } }] });
assert.deepStrictEqual([r.assigned.$L, r.assigned.$L2], ["GS-0001", "GS-0002"]);

// stock: receive 100, issue 80 OK, issue 30 more refused (only 20 left)
const mv = (id, qty, from, to, x) => Object.assign({ id, ts: "2026-11-10T10:00:00.000Z", type: "kit", sku: "PV", qty, from, to }, x || {});
r = post({ token: key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m1", 100, "SUPPLIER", "WH", { type: "receive" })] }] });
assert.ok(r.ok, r.error);
r = post({ token: key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m2", 80, "WH", "JOB:J-1001")] }, { op: "upsert", sheet: "Jobs", rows: [{ no: "J-1001", status: "kitted" }], expect: { field: "status", values: ["quoted"] } }] });
assert.ok(r.ok, r.error);
r = post({ token: key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m3", 30, "WH", "JOB:J-1002")] }] });
assert.strictEqual(r.ok, false); assert.ok(/Not enough/.test(r.error));

// job step check: kitting J-1001 again is refused, and NOTHING from that save is written (all-or-nothing)
const before = sheets.Moves.rows.length;
r = post({ token: key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m4", 5, "WH", "JOB:J-1001")] }, { op: "upsert", sheet: "Jobs", rows: [{ no: "J-1001", status: "kitted" }], expect: { field: "status", values: ["quoted"] } }] });
assert.strictEqual(r.ok, false); assert.ok(/already moved on/.test(r.error));
assert.strictEqual(sheets.Moves.rows.length, before, "refused save wrote nothing");

// quote lines can't change after kitting
r = post({ token: key, ops: [{ op: "replaceLines", sheet: "Lines", job: "J-1001", rows: [] }] });
assert.strictEqual(r.ok, false);

// retry safety: same batch id twice is applied once; same movement id twice saved once
const batch = { token: key, batch: "b-123", ops: [{ op: "append", sheet: "Moves", rows: [mv("m5", 3, "JOB:J-1001", "WH", { type: "return" })] }] };
assert.ok(post(batch).ok);
r = post(batch);
assert.ok(r.ok);
assert.strictEqual(sheets.Moves.rows.filter(x => x[0] === "m5").length, 1);
r = post({ token: key, batch: "b-other", ops: batch.ops });
assert.strictEqual(sheets.Moves.rows.filter(x => x[0] === "m5").length, 1);

// incremental sync: phone has 2 movements -> only the newer ones come back
r = post({ token: key, have: 2 });
assert.strictEqual(r.data.movesFrom, 2); assert.strictEqual(r.data.Moves.length, r.data.movesTotal - 2);
r = post({ token: key, have: 999 });
assert.strictEqual(r.data.movesFrom, 0, "phone ahead of the sheet -> full resend");

// movements can't be edited; unknown tabs and bad removes refused
assert.strictEqual(post({ token: key, ops: [{ op: "upsert", sheet: "Moves", rows: [{ id: "m1" }] }] }).ok, false);
assert.strictEqual(post({ token: key, ops: [{ op: "upsert", sheet: "Secrets", rows: [{}] }] }).ok, false);
assert.strictEqual(post({ token: key, ops: [{ op: "remove", sheet: "Jobs", rows: [{ no: "J-1" }] }] }).ok, false);
assert.strictEqual(post({ token: key, ops: [{ op: "append", sheet: "Moves", rows: [{ id: "x", sku: "PV", qty: 0 }] }] }).ok, false);

// formula guard
post({ token: key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "EVIL", name: "=IMPORTXML(\"http://x\")" }] }] });
assert.ok(sheets.Items.rows.some(row => row[1] === "'=IMPORTXML(\"http://x\")"));

console.log("backend: all tests passed");

// --- roles are enforced by the Sheet ---
const m = (id, extra) => Object.assign({ id, ts: "2026-11-10T11:00:00.000Z", type: "topup", sku: "PV", qty: 1, from: "WH", to: "VAN-1" }, extra || {});
r = post({ token: TS, ops: [{ op: "append", sheet: "Moves", rows: [m("s1", { by: "admin" })] }] });
assert.ok(r.ok, r.error);
assert.strictEqual(sheets.Moves.rows.find(x => x[0] === "s1")[15], "sipho", "who did it comes from the sign-in, not the phone");
assert.ok(/corrections/.test(post({ token: TS, ops: [{ op: "append", sheet: "Moves", rows: [m("s2", { type: "reverse", from: "VAN-1", to: "WH" })] }] }).error));
assert.ok(/can change items/.test(post({ token: TS, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "renamed" }] }] }).error));
assert.ok(post({ token: TS, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", cost: 20 }] }] }).ok, "receiving can update average cost");
assert.ok(/van kit/.test(post({ token: TS, ops: [{ op: "upsert", sheet: "VanKit", rows: [{ sku: "PV", target: 1 }] }] }).error));
assert.ok(/vans/.test(post({ token: TS, ops: [{ op: "create", sheet: "Vans", ref: "$V", row: { name: "x" } }] }).error));
assert.ok(post({ token: TS, ops: [{ op: "create", sheet: "Jobs", ref: "$J", row: { client: "S", status: "quoted" } }] }).ok, "storeman can open jobs");
assert.ok(/view only/.test(post({ token: TV, ops: [{ op: "append", sheet: "Moves", rows: [m("v1")] }] }).error));
assert.ok(post({ token: TV }).ok, "viewer can read");
assert.ok(/Unknown tab/.test(post({ token: T, ops: [{ op: "upsert", sheet: "Users", rows: [{ username: "x", role: "admin" }] }] }).error), "users can't be touched through data saves");
assert.strictEqual(post({ token: T }).data.Sessions, undefined);

// PIN reset and switching off sign the person out everywhere
assert.ok(post({ action: "users", token: T, cmd: "resetPin", username: "sipho", pin: "6047" }).ok);
assert.ok(post({ action: "sync", token: TS }).signIn, "reset PIN signs out old sessions");
assert.ok(post({ action: "users", token: T, cmd: "save", isNew: false, user: { username: "owner", name: "Owner", role: "viewer", active: "no" } }).ok);
assert.ok(post({ action: "sync", token: TV }).signIn);
assert.ok(/switched off/.test(post({ action: "login", username: "owner", pin: "2864" }).error));
// promoting to admin needs a 6-digit PIN
assert.ok(/6 to 8/.test(post({ action: "users", token: T, cmd: "save", isNew: false, user: { username: "sipho", name: "Sipho M", role: "admin" }, pin: "1593" }).error));
// logout ends this device only
const T2 = post({ action: "login", username: "admin", pin: ADMIN_PIN }).token;
assert.ok(post({ action: "logout", token: T2 }).ok);
assert.ok(post({ action: "sync", token: T2 }).signIn);
assert.ok(post({ action: "sync", token: T }).ok, "other admin device still signed in");

console.log("backend roles: all tests passed");

// --- v1.3 inventory rules ---
{
  const TS2 = signIn("sipho", "6047", "7140");
  const adj = (id, type, from, to) => ({ id, ts: "2026-11-10T12:00:00.000Z", type, sku: "PV", qty: 1, from, to });
  assert.ok(/Submit the count/.test(post({ token: TS2, ops: [{ op: "append", sheet: "Moves", rows: [adj("a1", "countshort", "WH", "LOSS")] }] }).error), "storeman can't write off store stock");
  assert.ok(/Submit the count/.test(post({ token: TS2, ops: [{ op: "append", sheet: "Moves", rows: [adj("a2", "adjust", "LOSS", "WH")] }] }).error));
  assert.ok(post({ token: TS2, ops: [{ op: "append", sheet: "Moves", rows: [adj("a3", "kituse", "VAN-1", "USED")] }] }).ok, "van kit counts still allowed");
  // storeman submits a count; it's stamped with their name
  r = post({ token: TS2, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c1", place: "WH", status: "pending", by: "admin", lines: "[]", value: -10 }] }] });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.Counts[0].by, "sipho");
  assert.ok(/can approve or reject/.test(post({ token: TS2, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c1", status: "approved" }] }] }).error));
  assert.ok(/can approve or reject/.test(post({ token: TS2, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c2", status: "approved" }] }] }).error), "can't submit pre-approved");
  // admin approves once; a second approval is refused
  const approve = { op: "upsert", sheet: "Counts", rows: [{ id: "c1", status: "approved", decidedAt: "x" }], expect: { field: "status", values: ["pending"] } };
  r = post({ token: T, ops: [{ op: "append", sheet: "Moves", rows: [adj("a4", "countshort", "WH", "LOSS")] }, approve] });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.Counts[0].decidedBy, "admin");
  assert.ok(/already moved on|changed on another device/.test(post({ token: T, ops: [approve] }).error), "can't approve twice");
  // Warehouse Manager: inventory powers, no login management, can't approve own count
  assert.ok(/6 to 8/.test(post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "mgr", name: "Mgr", role: "manager" }, pin: "5832" }).error), "managers need 6 digits");
  assert.ok(post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "mgr", name: "Mgr", role: "manager" }, pin: "583217" }).ok);
  const TM = signIn("mgr", "583217", "640291");
  assert.ok(post({ token: TM, ops: [{ op: "append", sheet: "Moves", rows: [adj("m1", "adjust", "WH", "LOSS")] }] }).ok, "manager adjusts stock");
  assert.ok(post({ token: TM, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "PV red 6mm" }] }] }).ok, "manager edits items");
  assert.ok(/Only a Senior Admin/.test(post({ action: "users", token: TM, cmd: "save", isNew: true, user: { username: "x2", name: "x", role: "storeman" }, pin: "5832" }).error));
  assert.strictEqual(post({ token: TM }).data.Users, undefined, "manager doesn't see logins");
  post({ token: TM, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c9", place: "WH", status: "pending", lines: "[]" }] }] });
  assert.ok(/own count/.test(post({ token: TM, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c9", status: "approved" }], expect: { field: "status", values: ["pending"] } }] }).error));
  post({ token: TS2, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c10", place: "WH", status: "pending", lines: "[]" }] }] });
  assert.ok(post({ token: TM, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "c10", status: "approved" }], expect: { field: "status", values: ["pending"] } }] }).ok, "manager approves a User's count");
  console.log("backend inventory: all tests passed");
}

// --- v1.4 sheet: admin PIN from the spreadsheet menu, spaces in PINs ---
{
  const { ctx, post, cache } = makeGas();
  assert.ok(/don't match/.test((() => { try { ctx.setAdminPin_("482915", "482916"); } catch (e) { return e.message; } })()));
  assert.ok(/simple run/.test((() => { try { ctx.setAdminPin_("123456", "123456"); } catch (e) { return e.message; } })()));
  for (let i = 0; i < 5; i++) post({ action: "login", username: "admin", pin: "000000" });
  assert.ok(/locked/.test(post({ action: "login", username: "admin", pin: "000000" }).error));
  assert.ok(/LOCKED/.test(ctx.adminStatus_()));
  ctx.setAdminPin_(" 482 915", "482915 ");
  const r1 = post({ action: "login", username: "admin", pin: "482915" });
  assert.ok(r1.ok, r1.error); assert.strictEqual(r1.user.mustChange, false, "PIN set from the menu needs no temporary step, and lockout is cleared");
  assert.ok(post({ action: "login", username: "admin", pin: " 482 915 " }).ok, "spaces in a typed PIN are ignored");
  assert.ok(/Switched on: yes/.test(ctx.adminStatus_()) && /Must choose own PIN at next sign-in: no/.test(ctx.adminStatus_()));
  // temporary PIN flow still works, with spaces
  const tmp = ctx.resetAdmin();
  const r2 = post({ action: "login", username: "admin", pin: tmp + " " });
  assert.ok(r2.ok && r2.user.mustChange);
  assert.ok(post({ action: "changePin", token: r2.token, oldPin: " " + tmp, newPin: "640 291" }).ok);
  assert.ok(post({ action: "login", username: "admin", pin: "640291" }).ok);
  console.log("backend v1.4 admin PIN: all tests passed");
}

// --- v1.5 sheet: keyed PIN hashes, old-hash upgrade, system-wide limit, size limits, private log ---
{
  const { ctx, post, sheets, props, cache } = makeGas();
  ctx.setAdminPin_("482915", "482915");
  const users = () => sheets.Users.rows.slice(1);
  const adminRow = () => users().find(r => r[0] === "admin");
  const pinHashCol = 6, saltCol = 5;
  assert.ok(String(adminRow()[pinHashCol]).startsWith("v2:"), "new hashes are keyed (v2)");
  assert.ok(props.PIN_PEPPER && props.PIN_PEPPER.length >= 32, "the key lives in Script Properties");
  const everyCell = Object.values(sheets).flatMap(s => s.rows.flat()).map(String);
  assert.ok(!everyCell.some(c => c.includes(props.PIN_PEPPER)), "the key is never written to the Sheet");
  // a hash made without the key no longer matches the PIN: a leaked Sheet alone isn't enough
  const crypto = require("crypto");
  const unkeyed = crypto.createHash("sha256").update(adminRow()[saltCol] + ":482915").digest("hex");
  assert.notStrictEqual(adminRow()[pinHashCol], unkeyed);
  // old v1 hash (from Sheet version 1.4) still signs in, and is upgraded on the way
  const salt = "old-salt";
  adminRow()[saltCol] = salt; adminRow()[pinHashCol] = crypto.createHash("sha256").update(salt + ":482915").digest("hex");
  const r = post({ action: "login", username: "admin", pin: "482915" });
  assert.ok(r.ok, r.error);
  assert.ok(String(adminRow()[pinHashCol]).startsWith("v2:"), "old hash upgraded after sign-in");
  assert.ok(post({ action: "login", username: "admin", pin: "482915" }).ok, "still works after upgrade");
  const T = r.token;
  // size limits
  assert.ok(/too large/.test(post({ token: T, ops: [], pad: "x".repeat(1000001) }).error), "huge request refused");
  assert.ok(/Too many changes/.test(post({ token: T, ops: Array.from({ length: 301 }, () => ({ op: "upsert", sheet: "Vans", rows: [] })) }).error));
  assert.ok(/Too many rows/.test(post({ token: T, ops: [{ op: "upsert", sheet: "Items", rows: Array.from({ length: 3001 }, (_, i) => ({ sku: "S" + i })) }] }).error));
  assert.ok(post({ token: T, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "LONG", name: "n".repeat(5000) }, { sku: "TAB", name: "\t=1+1" }] }] }).ok);
  const items = post({ token: T }).data.Items;
  assert.strictEqual(items.find(i => i.sku === "LONG").name.length, 2000, "long text trimmed");
  assert.ok(items.find(i => i.sku === "TAB").name.startsWith("'"), "tab-formula stored as text");
  // private log: written, never sent to phones
  assert.strictEqual(post({ token: T }).data.Log, undefined, "log never sent to the phone");
  assert.ok(/Unknown tab/.test(post({ token: T, ops: [{ op: "upsert", sheet: "Log", rows: [{ ts: "x" }] }] }).error), "log can't be written from a phone");
  const events = sheets.Log.rows.slice(1).map(r => r[2]);
  assert.ok(events.includes("admin PIN set") && events.includes("signed in"));
  // system-wide limit: many wrong guesses across made-up usernames pause new sign-ins
  for (let i = 0; i < 30; i++) post({ action: "login", username: "guess" + i, pin: "111222" });
  assert.ok(/paused/.test(post({ action: "login", username: "admin", pin: "482915" }).error), "new sign-ins paused");
  assert.ok(post({ token: T }).ok, "phones already signed in keep working");
  assert.ok(/PAUSED/.test(ctx.adminStatus_()));
  ctx.setAdminPin_("482915", "482915");
  assert.ok(post({ action: "login", username: "admin", pin: "482915" }).ok, "Set admin PIN… clears the pause");
  assert.ok(sheets.Log.rows.slice(1).some(r => r[2] === "sign-in failed" && r[3] === "no such login"));
  // log trims itself
  for (let i = 0; i < 1150; i++) ctx.log_("x", "test", "");
  assert.ok(sheets.Log.rows.length - 1 <= 1101, "log keeps only the latest rows");
  console.log("backend v1.5 security: all tests passed");
}

// --- v1.6 sheet: saving past row 1,000, and the exception rules ---
{
  const { ctx, post, sheets } = makeGas();
  ctx.setAdminPin_("482915", "482915");
  const T = post({ action: "login", username: "admin", pin: "482915" }).token;
  assert.ok(post({ token: T, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV6", name: "PV cable 6mm", uom: "m", cost: 12 }] }] }).ok);
  // 12 saves of 100 receipts = 1,200 Moves rows: past the 1,000 rows a new tab has
  for (let b = 0; b < 12; b++) {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `R${b}-${i}`, ts: new Date().toISOString(), type: "receive", sku: "PV6", qty: 1, from: "SUPPLIER", to: "WH", unitCost: 12, value: 12, ref: "INV-" + b }));
    const r = post({ token: T, ops: [{ op: "append", sheet: "Moves", rows }] });
    assert.ok(r.ok, "save " + b + ": " + r.error);
  }
  assert.strictEqual(sheets.Moves.rows.length - 1, 1200, "all 1,200 movements stored");
  const d = post({ token: T }).data;
  assert.strictEqual(d.Moves.length, 1200);
  assert.ok(sheets.Moves.getMaxRows() >= 1201, "the tab grew");
  console.log("backend v1.6 row capacity: all tests passed");
}
{
  const { ctx, sheets } = makeGas();
  const DAY = 864e5, now = Date.parse("2026-11-12T08:00:00Z"), ago = n => new Date(now - n * DAY).toISOString();
  const s = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? "" : String(v)]));
  const d = {
    Items: [{ sku: "PV6", name: "PV cable 6mm", uom: "m", cost: 12, reorder: 0, allowancePct: 10 }, { sku: "PNL", name: "Panel 550W", uom: "ea", cost: 2000, reorder: 10, allowancePct: "" }, { sku: "LUG", name: "Lug", uom: "ea", cost: 5, reorder: 0 }].map(s),
    Vans: [{ id: "VAN-1", name: "Van 1" }].map(s),
    Jobs: [
      { no: "J-1", client: "A", status: "out", installer: "Sipho", outAt: ago(10) },          // left open 10 days with stock
      { no: "J-2", client: "B", status: "out", installer: "Sipho", outAt: ago(2) },           // open 2 days, fine
      { no: "J-3", client: "C", status: "kitted", installer: "Pieter", kittedAt: ago(5) },    // crate not collected
      { no: "J-4", client: "D", status: "closed", installer: "Sipho", closedAt: ago(3), missingValue: 60 },
      { no: "J-5", client: "E", status: "closed", installer: "Sipho", closedAt: ago(20), missingValue: 24 }
    ].map(s),
    Lines: [{ job: "J-1", sku: "PV6", quoted: 22 }, { job: "J-2", sku: "PV6", quoted: 22 }, { job: "J-3", sku: "PNL", quoted: 6 }, { job: "J-4", sku: "PV6", quoted: 20 }, { job: "J-5", sku: "PV6", quoted: 20 }].map((l, i) => s(Object.assign({ id: "L" + i }, l))),
    Moves: [
      { type: "receive", sku: "PV6", qty: 500, from: "SUPPLIER", to: "WH", ts: ago(30) },
      { type: "receive", sku: "PNL", qty: 8, from: "SUPPLIER", to: "WH", ts: ago(30) },
      { type: "kit", sku: "PV6", qty: 25, from: "WH", to: "JOB:J-1", job: "J-1", ts: ago(11) },   // 22 +10% = 24.2 -> 25: the allowance, NOT over quote
      { type: "kit", sku: "PV6", qty: 25, from: "WH", to: "JOB:J-2", job: "J-2", ts: ago(3) },
      { type: "extra", sku: "PV6", qty: 6, from: "WH", to: "JOB:J-2", job: "J-2", ts: ago(2) },   // 31 issued vs kit 25 + 2.2 tolerance -> over
      { type: "extra", sku: "LUG", qty: 10, from: "WH", to: "JOB:J-2", job: "J-2", ts: ago(2) },  // not on quote (WH goes negative -> integrity rule)
      { type: "kit", sku: "PNL", qty: 6, from: "WH", to: "JOB:J-3", job: "J-3", ts: ago(5) },
      { type: "kit", sku: "PV6", qty: 30, from: "WH", to: "JOB:J-4", job: "J-4", ts: ago(6) },
      { type: "used", sku: "PV6", qty: 25, from: "JOB:J-4", to: "USED", job: "J-4", ts: ago(3) },
      { type: "missing", sku: "PV6", qty: 5, from: "JOB:J-4", to: "LOSS", job: "J-4", installer: "Sipho", value: 60, ts: ago(3) },
      { type: "missing", sku: "PV6", qty: 2, from: "WH", to: "LOSS", job: "J-5", installer: "Sipho", value: 24, ts: ago(20) },
      { type: "kituse", sku: "PV6", qty: 50, from: "VAN-1", to: "USED", van: "VAN-1", value: 600, ts: ago(1) },
      { type: "reverse", reverses: "return", sku: "PV6", qty: 1, from: "WH", to: "JOB:J-1", job: "J-1", value: 12, reason: "typo", by: "lebo", ts: ago(1) }
    ].map((m, i) => s(Object.assign({ id: "M" + i }, m))),
    Counts: [{ id: "CNT-1", status: "pending", ts: ago(3), by: "sipho", value: -10 }, { id: "CNT-2", status: "pending", ts: ago(0.5), by: "sipho" }].map(s)
  };
  const ex = ctx.exceptions_(d, now);
  const find = (rule, ref) => ex.filter(e => e.rule === rule && (ref === undefined || e.ref === ref));
  assert.strictEqual(find("Job on site, not closed", "J-1").length, 1, "J-1 left open");
  assert.strictEqual(find("Job on site, not closed", "J-1")[0].severity, "High", "with stock -> High");
  assert.strictEqual(find("Job on site, not closed", "J-2").length, 0, "J-2 only 2 days");
  assert.strictEqual(find("Crate packed, not collected", "J-3").length, 1);
  assert.strictEqual(find("Issued over quote", "J-1").length, 0, "cable allowance is not over quote");
  assert.strictEqual(find("Issued over quote", "J-2").length, 1, "extras beyond allowance + tolerance flagged");
  assert.strictEqual(find("Issued, not on quote", "J-2").length, 1);
  assert.strictEqual(find("Used over quote", "J-4").length, 1, "closed J-4 consumed 30 vs 20");
  assert.strictEqual(find("Missing after job", "J-4").length, 1, "recent missing");
  assert.strictEqual(find("Missing after job", "J-5").length, 0, "older than the window");
  assert.strictEqual(find("Repeat missing stock", "Sipho").length, 1, "2 jobs in 30 days");
  assert.strictEqual(find("Van kit shortfall", "Van 1").length, 1);
  assert.strictEqual(find("Low stock", "PNL").length, 1);
  assert.strictEqual(find("Count waiting for approval", "CNT-1").length, 1);
  assert.strictEqual(find("Count waiting for approval", "CNT-2").length, 0);
  assert.strictEqual(find("Correction made").length, 1);
  assert.strictEqual(find("Negative stock", "WH").length, 1, "LUG issued with none received");
  const sev = ex.map(e => e.severity), rank = { High: 0, Medium: 1, Low: 2 };
  assert.ok(sev.every((x, i) => i === 0 || rank[sev[i - 1]] <= rank[x]), "sorted High first");
  // writes the tab, and a clean dataset says "All clear"
  for (const n of ["Items", "Jobs", "Lines", "Moves", "Counts", "Vans"]) {
    d[n].forEach(r => sheets[n].rows.push(ctx.SHEETS[n].cols.map(c => r[c] || "")));
  }
  const c = ctx.checkExceptions(now);
  assert.strictEqual(c.high + c.medium + c.low, ex.length);
  assert.strictEqual(JSON.stringify(sheets.Exceptions.rows[0]), JSON.stringify(ctx.EXC_COLS));
  assert.strictEqual(sheets.Exceptions.rows.length - 1, ex.length);
  const g2 = makeGas(); g2.ctx.checkExceptions(now);
  assert.strictEqual(g2.sheets.Exceptions.rows[1][2], "All clear");
  // the Exceptions tab is never sent to phones and can't be written from one
  g2.ctx.setAdminPin_("482915", "482915");
  const T2 = g2.post({ action: "login", username: "admin", pin: "482915" }).token;
  assert.strictEqual(g2.post({ token: T2 }).data.Exceptions, undefined);
  assert.ok(/Unknown tab/.test(g2.post({ token: T2, ops: [{ op: "upsert", sheet: "Exceptions", rows: [{ checked: "x" }] }] }).error));
  console.log("backend v1.6 exception rules: all tests passed");
}
