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

// --- v1.7 sheet: manager override (a manager approves on a User's phone) ---
{
  const { ctx, post, sheets, cache } = makeGas();
  ctx.setAdminPin_("482915", "482915");
  const A = post({ action: "login", username: "admin", pin: "482915" }).token;
  const mkUser = (u, role, pin) => assert.ok(post({ action: "users", token: A, cmd: "save", isNew: true, user: { username: u, name: u, role }, pin }).ok);
  mkUser("lebo", "manager", "583217"); mkUser("mona", "manager", "694815"); mkUser("sipho", "storeman", "5832"); mkUser("zed", "storeman", "7391");
  mkUser("owner", "viewer", "4821"); mkUser("gone", "manager", "725813");
  const login = (u, pin, np) => { const x = post({ action: "login", username: u, pin }); assert.ok(x.ok, x.error); assert.ok(post({ action: "changePin", token: x.token, oldPin: pin, newPin: np }).ok); return x.token; };
  const TS = login("sipho", "5832", "7140"), TL = login("lebo", "583217", "640291"), TO = login("owner", "4821", "2864");
  login("zed", "7391", "9315");
  login("gone", "725813", "640293");
  assert.ok(post({ action: "users", token: A, cmd: "save", isNew: false, user: { username: "gone", name: "gone", role: "manager", active: "no" } }).ok);
  const LEBO = { username: "lebo", pin: "640291" };
  const col = (sheet, name) => ctx.SHEETS[sheet].cols.indexOf(name);
  const moveRow = id => sheets.Moves.rows.find(r => r[0] === id);
  const logs = () => sheets.Log.rows.slice(1).map(r => r.join("|"));
  const ts = "2026-11-12T09:00:00.000Z";
  const M = (id, o) => Object.assign({ id, ts, type: "receive", sku: "PV", qty: 10, from: "SUPPLIER", to: "WH" }, o || {});
  const REV = (id, orig, o) => Object.assign({ id, ts, type: "reverse", reverses: orig.type, ref: orig.id, sku: orig.sku, qty: orig.qty, from: orig.to, to: orig.from, reason: "typo" }, o || {});
  assert.ok(post({ token: A, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "PV red", uom: "m", track: "qty", cost: 10 }] }, { op: "append", sheet: "Moves", rows: [M("base", { qty: 100 })] }] }).ok);
  assert.ok(post({ token: TS, ops: [{ op: "append", sheet: "Moves", rows: [M("r1"), M("r2"), M("r3"), M("r4"), M("r5")] }] }).ok, "storeman receives");
  const ov = (token, ops, override, batch) => post({ token, ops, override, batch });

  // columns: approvedBy is the LAST column
  assert.strictEqual(ctx.SHEETS.Moves.cols[ctx.SHEETS.Moves.cols.length - 1], "approvedBy");
  assert.strictEqual(sheets.Moves.rows[0][col("Moves", "approvedBy")], "approvedBy");

  // a User cannot reverse without an override, with the old message
  assert.ok(/Only a Warehouse Manager or Senior Admin can record corrections/.test(post({ token: TS, ops: [{ op: "append", sheet: "Moves", rows: [REV("x0", M("r1"))] }] }).error));
  // a phone cannot forge approvedBy on a normal save
  assert.ok(post({ token: TS, ops: [{ op: "append", sheet: "Moves", rows: [M("forge", { approvedBy: "lebo" })] }] }).ok);
  assert.strictEqual(moveRow("forge")[col("Moves", "approvedBy")], "");

  // valid override: User reverses; by = the User, approvedBy = the manager; Log written; no PIN anywhere
  const before = sheets.Log.rows.length;
  let r = ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("v1", M("r1"))] }], LEBO, "ob1");
  assert.ok(r.ok, r.error);
  assert.strictEqual(moveRow("v1")[col("Moves", "by")], "sipho");
  assert.strictEqual(moveRow("v1")[col("Moves", "approvedBy")], "lebo");
  assert.ok(logs().slice(before - 1).some(l => /manager approval\|lebo approved for sipho: 1 correction\(s\)/.test(l)));
  assert.ok(!JSON.stringify(r).includes("640291"), "response never contains the PIN");
  const everything = JSON.stringify([sheets, cache]);
  assert.ok(!everything.includes("640291"), "the manager's PIN is not stored in the Sheet, Log or cache");
  assert.ok(r.data.Moves.some(m => m.id === "v1" && m.approvedBy === "lebo"));
  // the same movement can't be corrected twice
  assert.ok(/already been corrected/.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("v1b", M("r1"))] }], LEBO).error));

  // replay: same batch id returns the cached result, doesn't re-check the PIN or write again
  const failBefore = cache.fail_all, rows = sheets.Moves.rows.length;
  r = ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("v1", M("r1"))] }], { username: "lebo", pin: "000000" }, "ob1");
  assert.ok(r.ok, "replayed override batch is answered from the cache");
  assert.strictEqual(cache.fail_all, failBefore, "replay doesn't touch the wrong-PIN counters");
  assert.strictEqual(sheets.Moves.rows.length, rows, "nothing written twice");
  // a repeated row id with a fresh batch id is also saved once
  assert.ok(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("v1", M("r1"))] }], LEBO, "ob1-again").ok);
  assert.strictEqual(sheets.Moves.rows.filter(x => x[0] === "v1").length, 1);

  // the reversal must be a real, matching undo (phone can't invent one)
  const bad = o => ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("bad", M("r2"), o)] }], LEBO);
  for (const o of [{ ref: "nope" }, { qty: 9 }, { from: "WH", to: "LOSS" }, { sku: "OTHER" }, { reverses: "kit" }, { ref: "v1" }])
    assert.ok(/only for corrections/.test(bad(o).error) || /already been corrected/.test(bad(o).error), JSON.stringify(o));
  assert.ok(!moveRow("bad"));

  // wrong PIN: refused as a whole, counted against that manager and system-wide, logged, nothing written
  const rows2 = sheets.Moves.rows.length;
  r = ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("w1", M("r2"))] }], { username: "lebo", pin: "111222" });
  assert.strictEqual(r.ok, false); assert.ok(/Manager username or PIN is wrong\./.test(r.error));
  assert.strictEqual(cache.fail_lebo, "1"); assert.ok(Number(cache.fail_all) >= 1);
  assert.ok(logs().some(l => /sipho\|manager approval failed\|lebo: wrong PIN \(1\)/.test(l)));
  assert.ok(!JSON.stringify(sheets.Log.rows).includes("111222"), "a wrong PIN is never logged");
  assert.strictEqual(sheets.Moves.rows.length, rows2);
  assert.ok(/Manager username or PIN is wrong/.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("w2", M("r2"))] }], { username: "nobody", pin: "111222" }).error), "unknown manager: same message");
  assert.ok(/Manager username or PIN is wrong/.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("w2", M("r2"))] }], "lebo").error), "malformed override: same message");
  const wrong = () => ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("w2", M("r2"))] }], { username: "lebo", pin: "111222" });
  wrong(); wrong(); assert.strictEqual(cache.fail_lebo, "3");
  assert.ok(/1 tries left/.test(wrong().error), "tries-left hint, like sign-in");
  wrong();
  r = ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("w3", M("r2"))] }], LEBO);
  assert.ok(/locked/.test(r.error), "5 wrong PINs lock that manager, even for the right PIN");
  assert.ok(/locked/.test(post({ action: "login", username: "lebo", pin: "640291" }).error), "the lock is the same one sign-in uses");
  assert.ok(!moveRow("w3"));
  delete cache.fail_lebo; delete cache.fail_all;
  // the system-wide counter pauses manager approval too
  cache.fail_all = "30";
  assert.ok(/paused/.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("w4", M("r2"))] }], LEBO).error));
  delete cache.fail_all;
  assert.ok(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("v2", M("r2"))] }], LEBO).ok, "works again once the counters clear");
  assert.strictEqual(cache.fail_lebo, undefined, "a right PIN clears that manager's counter");

  // approver must be an active manager/admin other than the signed-in user
  const rev3 = id => [{ op: "append", sheet: "Moves", rows: [REV(id, M("r3"))] }];
  const WHO = /Warehouse Manager or Senior Admin other than you/;
  assert.ok(WHO.test(ov(TS, rev3("a1"), { username: "zed", pin: "9315" }).error), "a User can't approve");
  assert.ok(WHO.test(ov(TS, rev3("a2"), { username: "owner", pin: "2864" }).error), "a Viewer can't approve");
  assert.ok(/Manager username or PIN is wrong/.test(ov(TS, rev3("a3"), { username: "gone", pin: "640293" }).error), "a switched-off manager can't approve");
  assert.ok(WHO.test(ov(TL, rev3("a4"), LEBO).error), "can't approve your own work");
  assert.ok(ov(TO, rev3("a5"), { username: "lebo", pin: "640291" }).error, "a Viewer phone can't use an override");
  assert.ok(WHO.test(ov(TS, rev3("a6"), { username: "SIPHO", pin: "7140" }).error), "can't approve as yourself");
  assert.ok(logs().some(l => /manager approval failed\|lebo: not a manager other than/.test(l)));
  ["a1", "a2", "a3", "a4", "a5", "a6"].forEach(id => assert.ok(!moveRow(id)));

  // scope: only reversals and count decisions
  const SCOPE = /only for corrections and count decisions/;
  assert.ok(SCOPE.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [M("s1")] }], LEBO).error), "a receive is not a correction");
  assert.ok(SCOPE.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("s2", M("r3")), M("s3")] }], LEBO).error), "one bad row refuses the batch");
  assert.ok(SCOPE.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [M("s4", { type: "countshort", from: "WH", to: "LOSS", ref: "c-none" })] }], LEBO).error), "count move without a decided count");
  assert.ok(SCOPE.test(ov(TS, [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", cost: 1 }] }], LEBO).error));
  assert.ok(SCOPE.test(ov(TS, [{ op: "create", sheet: "Vans", ref: "$V", row: { name: "x" } }], LEBO).error));
  assert.ok(SCOPE.test(ov(TS, [{ op: "upsert", sheet: "Jobs", rows: [{ no: "J-1", status: "closed" }] }], LEBO).error));
  assert.ok(SCOPE.test(ov(TS, [{ op: "replaceLines", sheet: "Lines", job: "J-1", rows: [] }], LEBO).error));
  assert.ok(SCOPE.test(ov(TS, [{ op: "remove", sheet: "Vans", rows: [{ id: "VAN-1" }] }], LEBO).error));
  assert.ok(SCOPE.test(ov(TS, [{ op: "upsert", sheet: "Counts", rows: [{ id: "brand-new", status: "pending" }] }], LEBO).error), "can't submit a count with an override");
  assert.ok(SCOPE.test(ov(TS, [{ op: "upsert", sheet: "Counts", rows: [{ id: "c-x", status: "approved", place: "VAN-1" }] }], LEBO).error), "can't change other count fields");
  assert.ok(!moveRow("s2") && !moveRow("s1"), "a refused override wrote nothing");

  // count decisions
  const line = (sku, system, counted) => ({ sku, system, counted, diff: counted - system, value: (counted - system) * 10 });
  const count = (id, by, lines, place) => post({ token: by, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id, place: place || "WH", status: "pending", lines: JSON.stringify(lines), value: -50 }] }] });
  assert.ok(count("c1", TS, [line("PV", 133, 128)]).ok);
  const decide = (id, st, extra) => ({ op: "upsert", sheet: "Counts", rows: [Object.assign({ id, status: st, decidedAt: "2026-11-12T10:00:00.000Z" }, extra || {})], expect: { field: "status", values: ["pending"] } });
  const cmove = (id, ref, o) => M(id, Object.assign({ type: "countshort", from: "WH", to: "LOSS", qty: 5, ref, reason: "Count by sipho, approved" }, o || {}));
  assert.ok(/can approve or reject/.test(post({ token: TS, ops: [decide("c1", "approved")] }).error), "a User still can't decide counts without an override");
  // phone leaves the adjustment out, or changes it: refused
  assert.ok(SCOPE.test(ov(TS, [decide("c1", "approved")], LEBO).error), "approval without its adjustment move");
  assert.ok(SCOPE.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [cmove("cm0", "c1", { qty: 1 })] }, decide("c1", "approved")], LEBO).error), "wrong quantity");
  assert.ok(SCOPE.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [cmove("cm0", "c1", { sku: "OTHER" })] }, decide("c1", "approved")], LEBO).error));
  assert.ok(SCOPE.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [cmove("cm0", "c1")] }, decide("c1", "rejected")], LEBO).error), "no stock moves when rejecting");
  assert.strictEqual(post({ token: TL }).data.Counts.find(c => c.id === "c1").status, "pending");
  r = ov(TS, [{ op: "append", sheet: "Moves", rows: [cmove("cm1", "c1")] }, decide("c1", "approved")], LEBO);
  assert.ok(r.ok, r.error);
  const c1 = r.data.Counts.find(c => c.id === "c1");
  assert.strictEqual(c1.status, "approved"); assert.strictEqual(c1.decidedBy, "lebo", "decidedBy is the manager, not the phone's user");
  assert.strictEqual(moveRow("cm1")[col("Moves", "by")], "sipho"); assert.strictEqual(moveRow("cm1")[col("Moves", "approvedBy")], "lebo");
  assert.ok(logs().some(l => /lebo approved for sipho: count c1 approved/.test(l)));
  assert.ok(/already been decided/.test(ov(TS, [decide("c1", "approved")], LEBO).error), "can't decide twice");
  // reject, with the reason kept; and the approver can't be the person who counted
  assert.ok(count("c2", TS, [line("PV", 100, 90)]).ok);
  r = ov(TS, [decide("c2", "rejected", { decisionNote: "recount please" })], { username: "mona", pin: "694815" });
  assert.ok(r.ok === false && /choose their own PIN/.test(r.error), "a manager still on a temporary PIN can't approve");
  const TM = login("mona", "694815", "731846");
  r = ov(TS, [decide("c2", "rejected", { decisionNote: "recount please" })], { username: "mona", pin: "731846" });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.Counts.find(c => c.id === "c2").decidedBy, "mona"); assert.strictEqual(r.data.Counts.find(c => c.id === "c2").decisionNote, "recount please");
  assert.ok(logs().some(l => /mona approved for sipho: count c2 rejected/.test(l)));
  assert.ok(count("c3", TL, [line("PV", 100, 95)]).ok, "a manager's own count");
  assert.ok(/own count/.test(ov(TS, [{ op: "append", sheet: "Moves", rows: [cmove("cm3", "c3")] }, decide("c3", "approved")], LEBO).error), "the approver who counted it is refused");
  assert.ok(!moveRow("cm3") && post({ token: TL }).data.Counts.find(c => c.id === "c3").status === "pending");
  // a zero-difference count needs no moves
  assert.ok(count("c4", TS, [line("PV", 50, 50)]).ok);
  assert.ok(ov(TS, [decide("c4", "approved")], LEBO).ok);
  // approving and reversing together, with the count decision first in the list
  assert.ok(count("c5", TS, [line("PV", 90, 85)]).ok);
  assert.ok(ov(TS, [decide("c5", "approved"), { op: "append", sheet: "Moves", rows: [cmove("cm5", "c5")] }], LEBO).ok, "order inside the batch doesn't matter");
  assert.ok(ov(TS, [{ op: "append", sheet: "Moves", rows: [REV("v5", M("r4"))] }], LEBO).ok, "and a correction is its own approval");
  // van count adjustments (kituse) are tied to their count the same way
  assert.ok(count("c6", TS, [line("PV", 10, 7)], "VAN-1").ok);
  assert.ok(post({ token: A, ops: [{ op: "append", sheet: "Moves", rows: [M("vt", { type: "topup", from: "WH", to: "VAN-1", qty: 10 })] }] }).ok);
  assert.ok(ov(TS, [{ op: "append", sheet: "Moves", rows: [cmove("cm6", "c6", { type: "kituse", from: "VAN-1", to: "USED", qty: 3 })] }, decide("c6", "approved")], LEBO).ok);

  // a manager acting alone is unchanged (no override needed, no approvedBy)
  assert.ok(post({ token: TL, ops: [{ op: "append", sheet: "Moves", rows: [REV("m1", M("r5"))] }] }).ok);
  assert.strictEqual(moveRow("m1")[col("Moves", "approvedBy")], "");

  // Moves still can't be edited with an override
  assert.ok(SCOPE.test(ov(TS, [{ op: "upsert", sheet: "Moves", rows: [{ id: "base", qty: 1 }] }], LEBO).error));

  // exception rules: a reversed stock-out gives the quantity back to the job; "approved by" shows on corrections
  const now = Date.parse("2026-11-12T12:00:00Z"), iso = h => new Date(now - h * 36e5).toISOString();
  const s = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? "" : String(v)]));
  const d = {
    Items: [s({ sku: "PV", name: "PV red", uom: "m", cost: 10 })], Vans: [], Counts: [],
    Jobs: [s({ no: "J-9", client: "Z", status: "out", installer: "Sipho", outAt: iso(5) })],
    Lines: [s({ id: "L9", job: "J-9", sku: "PV", quoted: 10 })],
    Moves: [
      s({ id: "k", type: "kit", sku: "PV", qty: 10, from: "WH", to: "JOB:J-9", job: "J-9", ts: iso(5) }),
      s({ id: "o", type: "out", sku: "PV", qty: 20, from: "WH", to: "JOB:J-9", job: "J-9", ts: iso(4) }),
      s({ id: "ro", type: "reverse", reverses: "out", ref: "o", sku: "PV", qty: 20, from: "JOB:J-9", to: "WH", job: "J-9", ts: iso(3), value: 200, reason: "wrong job", by: "sipho", approvedBy: "lebo" })
    ]
  };
  const ex = ctx.exceptions_(d, now);
  assert.strictEqual(ex.filter(e => /over quote/.test(e.rule)).length, 0, "a reversed stock-out no longer counts as issued to the job");
  const corr = ex.find(e => e.rule === "Correction made");
  assert.ok(/approved by lebo/.test(corr.detail), corr.detail);
  d.Moves.pop();
  assert.strictEqual(ctx.exceptions_(d, now).filter(e => /over quote/.test(e.rule)).length, 1, "without the reversal the stock-out is over quote");
  console.log("backend v1.7 manager override: all tests passed");
}

// --- v1.7 sheet: an existing Sheet (made by 1.6) gets the new Moves column without moving any data ---
{
  const { ctx, post, sheets } = makeGas();
  ctx.setAdminPin_("482915", "482915");
  const T = post({ action: "login", username: "admin", pin: "482915" }).token;
  const cols16 = ctx.SHEETS.Moves.cols.slice(0, -1);
  assert.strictEqual(cols16.length, 17);
  // turn the Moves tab back into what version 1.6 made: 17 headers and an old row
  const old = ["m-old", "2026-11-01T08:00:00.000Z", "receive", "PV", "7", "SUPPLIER", "WH", "", "", "", "", "9", "63", "INV-1", "", "sipho", ""];
  sheets.Moves.rows.length = 0; sheets.Moves.rows.push(cols16.slice(), old.slice());
  assert.strictEqual(sheets.Moves.rows[0].length, 17);
  let rd = post({ token: T }).data.Moves;
  assert.strictEqual(rd.length, 1); assert.strictEqual(rd[0].qty, "7"); assert.strictEqual(rd[0].approvedBy, "", "old rows read with a blank approvedBy");
  // the first save adds the header cell, leaves the old row alone, and writes the new row in the new column
  assert.ok(post({ token: T, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "PV", uom: "m", track: "qty", cost: 9 }] }, { op: "append", sheet: "Moves", rows: [{ id: "m-new", ts: "2026-11-02T08:00:00.000Z", type: "receive", sku: "PV", qty: 3, from: "SUPPLIER", to: "WH" }] }] }).ok);
  assert.strictEqual(sheets.Moves.rows[0].length, 18); assert.strictEqual(sheets.Moves.rows[0][17], "approvedBy");
  assert.deepStrictEqual(sheets.Moves.rows[0].slice(0, 17), cols16, "no header moved");
  assert.deepStrictEqual(sheets.Moves.rows[1].slice(0, 17), old, "old row untouched");
  assert.ok(!sheets.Moves.rows[1][17], "old row has a blank approvedBy");
  assert.strictEqual(sheets.Moves.rows[2][0], "m-new"); assert.strictEqual(sheets.Moves.rows[2][15], "admin");
  // running it again (and setup again) changes nothing
  const snap = JSON.stringify(sheets.Moves.rows);
  ctx.ensureColumns_("Moves"); ctx.setup();
  assert.strictEqual(JSON.stringify(sheets.Moves.rows), snap, "idempotent");
  rd = post({ token: T }).data.Moves;
  assert.deepStrictEqual(rd.map(m => m.id), ["m-old", "m-new"]);
  // and the override works on that upgraded Sheet
  assert.ok(post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "sipho", name: "S", role: "storeman" }, pin: "5832" }).ok);
  assert.ok(post({ action: "users", token: T, cmd: "save", isNew: true, user: { username: "lebo", name: "L", role: "manager" }, pin: "583217" }).ok);
  const TS = (() => { const x = post({ action: "login", username: "sipho", pin: "5832" }); post({ action: "changePin", token: x.token, oldPin: "5832", newPin: "7140" }); return x.token; })();
  const TL = (() => { const x = post({ action: "login", username: "lebo", pin: "583217" }); post({ action: "changePin", token: x.token, oldPin: "583217", newPin: "640291" }); return x.token; })();
  const r = post({ token: TS, override: { username: "lebo", pin: "640291" }, ops: [{ op: "append", sheet: "Moves", rows: [{ id: "rv", ts: "2026-11-03T08:00:00.000Z", type: "reverse", reverses: "receive", ref: "m-old", sku: "PV", qty: 7, from: "WH", to: "SUPPLIER", reason: "typo" }] }] });
  assert.ok(r.ok, r.error);
  assert.strictEqual(sheets.Moves.rows.find(x => x[0] === "rv")[17], "lebo");
  console.log("backend v1.7 column upgrade: all tests passed");
}

// --- fix round F1-F6: the Sheet, not the phone, decides who decided, what a correction copies, and what one approval covers ---
{
  const { ctx, post, sheets, cache } = makeGas();
  ctx.setAdminPin_("482915", "482915");
  const A = post({ action: "login", username: "admin", pin: "482915" }).token;
  const mkUser = (u, role, pin) => assert.ok(post({ action: "users", token: A, cmd: "save", isNew: true, user: { username: u, name: u, role }, pin }).ok);
  mkUser("lebo", "manager", "583217"); mkUser("mona", "manager", "694815"); mkUser("sipho", "storeman", "5832");
  const login = (u, pin, np) => { const x = post({ action: "login", username: u, pin }); assert.ok(x.ok, x.error); assert.ok(post({ action: "changePin", token: x.token, oldPin: pin, newPin: np }).ok); return x.token; };
  const TS = login("sipho", "5832", "7140"), TL = login("lebo", "583217", "640291"); login("mona", "694815", "731846");
  const LEBO = { username: "lebo", pin: "640291" }, MONA = { username: "mona", pin: "731846" };
  const col = (sheet, name) => ctx.SHEETS[sheet].cols.indexOf(name);
  const moveRow = id => sheets.Moves.rows.find(r => r[0] === id);
  const countRow = id => sheets.Counts.rows.find(r => r[0] === id);
  const cell = (row, sheet, name) => row[col(sheet, name)];
  const logs = () => sheets.Log.rows.slice(1).map(r => r.join("|"));
  const ts = "2026-11-12T09:00:00.000Z";
  const M = (id, o) => Object.assign({ id, ts, type: "receive", sku: "PV", qty: 10, from: "SUPPLIER", to: "WH" }, o || {});
  const REV = (id, orig, o) => Object.assign({ id, ts, type: "reverse", reverses: orig.type, ref: orig.id, sku: orig.sku, qty: orig.qty, from: orig.to, to: orig.from, reason: "typo" }, o || {});
  const app = (token, rows) => post({ token, ops: [{ op: "append", sheet: "Moves", rows }] });
  const ov = (ops, o) => post({ token: TS, ops, override: o || LEBO });
  const line = (sku, system, counted) => ({ sku, system, counted, diff: counted - system, value: (counted - system) * 10 });
  const ONE = /One manager approval covers one correction or one count decision/, SCOPE = /only for corrections and count decisions/;
  assert.ok(post({ token: A, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "PV red", uom: "m", track: "qty", cost: 10 }] }, { op: "append", sheet: "Moves", rows: [M("base", { qty: 100 })] },
    { op: "upsert", sheet: "Jobs", rows: [{ no: "J-1", client: "Z", status: "out", van: "VAN-1", installer: "Thabo" }, { no: "J-2", client: "Y", status: "closed" }, { no: "J-3", client: "X", status: "kitted" }] }] }).ok);
  assert.ok(app(TS, [M("r1"), M("r2"), M("r3"), M("r4"), M("r5"), M("r6")]).ok);

  // F1: forged decidedBy / decidedAt / decisionNote on a NEW count are blanked, for a User and for a manager
  const forged = id => ({ id, place: "WH", ts, status: "pending", lines: JSON.stringify([line("PV", 110, 100)]), value: -100, decidedBy: "lebo", decidedAt: ts, decisionNote: "ok", by: "lebo" });
  assert.ok(post({ token: TS, ops: [{ op: "upsert", sheet: "Counts", rows: [forged("C1")] }] }).ok);
  const bl = id => ["decidedBy", "decidedAt", "decisionNote"].map(n => cell(countRow(id), "Counts", n));
  assert.deepStrictEqual(bl("C1"), ["", "", ""]); assert.strictEqual(cell(countRow("C1"), "Counts", "by"), "sipho");
  assert.ok(post({ token: TL, ops: [{ op: "upsert", sheet: "Counts", rows: [forged("C2")] }] }).ok);
  assert.deepStrictEqual(bl("C2"), ["", "", ""]); assert.strictEqual(cell(countRow("C2"), "Counts", "by"), "lebo");
  // an update that is not a decision can't touch the decision fields (or who counted)
  assert.ok(post({ token: TL, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "C1", note: "hello", decidedBy: "mona", decidedAt: "x", decisionNote: "y", by: "mona" }] }] }).ok);
  assert.deepStrictEqual(bl("C1"), ["", "", ""]); assert.strictEqual(cell(countRow("C1"), "Counts", "note"), "hello"); assert.strictEqual(cell(countRow("C1"), "Counts", "by"), "sipho");
  // a decision: decidedBy is the actor whatever the phone sent
  assert.ok(post({ token: TL, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "C1", status: "rejected", decidedBy: "mona", decisionNote: "recount" }] }] }).ok);
  assert.strictEqual(cell(countRow("C1"), "Counts", "decidedBy"), "lebo"); assert.strictEqual(cell(countRow("C1"), "Counts", "decisionNote"), "recount");
  // a key called hasOwnProperty can't break the save
  assert.ok(post({ token: TL, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "C1", hasOwnProperty: 1, note: "again" }] }] }).ok);
  assert.strictEqual(cell(countRow("C1"), "Counts", "note"), "again");

  // F2: one manager approval = one action. Padded batches, both shapes, are refused and nothing is written
  const nMoves = () => sheets.Moves.rows.length, nCounts = () => sheets.Counts.rows.length;
  const n0 = nMoves();
  const decide = (id, st) => ({ op: "upsert", sheet: "Counts", rows: [{ id, status: st, decidedAt: ts }], expect: { field: "status", values: ["pending"] } });
  const cm = (id, ref, o) => M(id, Object.assign({ type: "countshort", from: "WH", to: "LOSS", qty: 10, ref, reason: "count" }, o || {}));
  assert.ok(post({ token: TS, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "C3", place: "WH", status: "pending", lines: JSON.stringify([line("PV", 110, 100)]), value: -100 }, { id: "C4", place: "WH", status: "pending", lines: JSON.stringify([line("PV", 110, 105)]), value: -50 }] }] }).ok);
  assert.ok(ONE.test(ov([{ op: "append", sheet: "Moves", rows: [REV("p1", M("r1")), REV("p2", M("r2"))] }]).error), "two reversals");
  assert.ok(ONE.test(ov([{ op: "append", sheet: "Moves", rows: [REV("p1", M("r1"))] }, { op: "append", sheet: "Moves", rows: [REV("p2", M("r2"))] }]).error), "two reversal ops");
  assert.ok(ONE.test(ov([decide("C3", "approved"), { op: "append", sheet: "Moves", rows: [cm("cm3", "C3"), REV("p3", cm("cm3", "C3"))] }]).error), "approve, book, and reverse the shortage in one go");
  assert.ok(ONE.test(ov([decide("C3", "approved"), { op: "append", sheet: "Moves", rows: [cm("cm3", "C3"), REV("p3", M("r3"))] }]).error), "approve and reverse another move");
  assert.ok(ONE.test(ov([decide("C3", "approved"), decide("C4", "approved"), { op: "append", sheet: "Moves", rows: [cm("cm3", "C3"), cm("cm4", "C4", { qty: 5 })] }]).error), "two count decisions");
  assert.ok(ONE.test(ov([{ op: "upsert", sheet: "Counts", rows: [{ id: "C3", status: "approved" }, { id: "C4", status: "rejected" }] }]).error), "two counts in one op");
  assert.ok(SCOPE.test(ov([decide("C3", "approved"), { op: "append", sheet: "Moves", rows: [cm("cm3", "C3"), cm("cm4", "C4", { qty: 5 })] }]).error), "a count move that belongs to another count");
  assert.ok(SCOPE.test(ov([{ op: "append", sheet: "Moves", rows: [REV("p1", M("r1")), M("p9")] }]).error), "a reversal plus a plain movement");
  assert.strictEqual(nMoves(), n0, "nothing written"); assert.strictEqual(cell(countRow("C3"), "Counts", "status"), "pending");
  // the single actions still work
  assert.ok(ov([{ op: "append", sheet: "Moves", rows: [cm("cm3", "C3")] }, decide("C3", "approved")]).ok);
  assert.strictEqual(cell(countRow("C3"), "Counts", "decidedBy"), "lebo");
  assert.ok(ov([decide("C4", "rejected")], MONA).ok);
  assert.ok(ov([{ op: "append", sheet: "Moves", rows: [REV("ok1", M("r1"))] }]).ok);

  // F3: a correction can't undo a movement saved in the same request (any role), needs a reason, and respects the job rule
  const n1 = nMoves();
  assert.ok(/saved earlier/.test(app(TL, [M("n1"), REV("nr1", M("n1"))]).error), "manager: same-save reversal");
  assert.ok(/saved earlier/.test(app(TL, [REV("nr2", M("n2")), M("n2")]).error), "manager: reversal listed before its movement");
  assert.ok(/saved earlier/.test(post({ token: TL, ops: [{ op: "append", sheet: "Moves", rows: [M("n3")] }, { op: "append", sheet: "Moves", rows: [REV("nr3", M("n3"))] }] }).error), "manager: across two ops");
  assert.strictEqual(nMoves(), n1);
  for (const reason of ["", "   ", undefined]) {
    assert.ok(/reason/.test(app(TL, [REV("nr4", M("r2"), { reason })]).error), "manager: no reason");
    assert.ok(/reason/.test(ov([{ op: "append", sheet: "Moves", rows: [REV("nr5", M("r2"), { reason })] }]).error), "override: no reason");
  }
  assert.ok(/can't be corrected/.test(app(TL, [REV("nr6", M("nope"))]).error), "manager: unknown movement");
  assert.ok(/already been corrected/.test(app(TL, [REV("nr7", M("r1"))]).error), "manager: twice");
  assert.ok(!moveRow("nr4") && !moveRow("nr5"));
  // job rule: closed (or missing) job refuses; open job and kitted-out-to-job are fine
  const jm = (id, job, type, to) => ({ id, ts, type: type || "extra", sku: "PV", qty: 2, from: "WH", to: to || "JOB:" + job, job, van: "VAN-1", installer: "Thabo", serial: "SN1", unitCost: 10, value: 20 });
  assert.ok(app(A, [jm("j1", "J-1"), jm("j2", "J-2"), jm("j3", "J-3", "out"), jm("j4", "J-3", "extra"), jm("j5", "J-9")]).ok);
  const JC = /This job is closed; its movements can't be corrected/;
  assert.ok(JC.test(app(TL, [REV("jr2", jm("j2", "J-2"))]).error), "closed job, manager");
  assert.ok(JC.test(ov([{ op: "append", sheet: "Moves", rows: [REV("jr2", jm("j2", "J-2"))] }]).error), "closed job, override");
  assert.ok(JC.test(app(TL, [REV("jr4", jm("j4", "J-3", "extra"))]).error), "an extra to a kitted job is not correctable");
  assert.ok(JC.test(app(TL, [REV("jr5", jm("j5", "J-9"))]).error), "job that doesn't exist");
  assert.ok(app(TL, [REV("jr1", jm("j1", "J-1"))]).ok, "open job");
  assert.ok(ov([{ op: "append", sheet: "Moves", rows: [REV("jr3", jm("j3", "J-3", "out"))] }]).ok, "a stock out to a kitted job is correctable");

  // F4: a correction copies job / van / installer / serial / unitCost / value from the original; ts is the Sheet's time
  const t0 = Date.now();
  assert.ok(ov([{ op: "append", sheet: "Moves", rows: [REV("fv", M("r3"), { value: 999999, unitCost: 0.01, job: "J-1", van: "VAN-9", installer: "evil", serial: "XX", ts: "2020-01-01T00:00:00.000Z" })] }]).ok);
  let fv = moveRow("fv");
  assert.deepStrictEqual(["job", "van", "installer", "serial", "unitCost", "value"].map(n => cell(fv, "Moves", n)), ["", "", "", "", "", ""], "the original had none of these");
  assert.ok(Date.parse(cell(fv, "Moves", "ts")) >= t0 - 1000, "server time");
  assert.strictEqual(cell(fv, "Moves", "by"), "sipho"); assert.strictEqual(cell(fv, "Moves", "approvedBy"), "lebo");
  assert.ok(app(TL, [REV("jr1x", jm("j1b", "J-1"))]).error, "unknown original");
  assert.ok(app(A, [jm("j6", "J-1")]).ok);
  assert.ok(app(TL, [REV("fv2", jm("j6", "J-1"), { value: 1, unitCost: 1, job: "J-3", van: "VAN-7", installer: "x", serial: "y", ts: "2001-01-01T00:00:00.000Z" })]).ok);
  fv = moveRow("fv2");
  assert.deepStrictEqual(["job", "van", "installer", "serial", "unitCost", "value"].map(n => cell(fv, "Moves", n)), ["J-1", "VAN-1", "Thabo", "SN1", "10", "20"], "copied from the original, even for a manager");
  assert.ok(Date.parse(cell(fv, "Moves", "ts")) >= t0 - 1000);

  // F5: built-in names as keys can't hit Object.prototype
  assert.ok(app(TS, [M("constructor")]).ok && moveRow("constructor"), "a movement with the id 'constructor' is saved, not mistaken for a duplicate");
  assert.ok(app(TS, [M("__proto__")]).ok && moveRow("__proto__"));
  assert.ok(/can't be corrected/.test(app(TL, [REV("fp1", M("toString"), { ref: "toString" })]).error));
  assert.ok(/only for corrections/.test(ov([{ op: "append", sheet: "Moves", rows: [REV("fp2", M("r4"), { ref: "valueOf" })] }]).error));
  assert.ok(!moveRow("fp1") && !moveRow("fp2"));
  assert.ok(/Unknown tab/.test(post({ token: TL, ops: [{ op: "upsert", sheet: "constructor", rows: [{ id: "x" }] }] }).error));
  assert.ok(/Unknown tab/.test(post({ token: TL, ops: [{ op: "create", sheet: "__proto__", row: {} }] }).error));
  assert.ok(SCOPE.test(ov([{ op: "upsert", sheet: "Counts", rows: [{ id: "C3", status: "approved", constructor: 1 }] }]).error));
  assert.ok(/only for corrections/.test(ov([{ op: "append", sheet: "Moves", rows: [REV("fp3", M("r4"), { ref: "hasOwnProperty", reverses: "hasOwnProperty" })] }]).error));

  // F6: a Moves header edited by hand stops the save, with nothing written (not even the other ops in the request)
  const hdr = sheets.Moves.rows[0], good = hdr[3], n2 = nMoves(), cost0 = sheets.Items.rows.find(r => r[0] === "PV")[col("Items", "cost")];
  hdr[3] = "SKU (item)";
  let r = post({ token: TL, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", cost: 77 }] }, { op: "append", sheet: "Moves", rows: [M("h1")] }] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "The Moves tab header has been edited; column 4 should be 'sku'. Fix the header row, then try again.");
  assert.strictEqual(nMoves(), n2); assert.strictEqual(sheets.Items.rows.find(r => r[0] === "PV")[col("Items", "cost")], cost0, "the Items change in the same request wasn't written either");
  assert.ok(logs().some(l => /sipho|lebo/.test(l) && /sheet header problem\|The Moves tab header has been edited/.test(l)), "logged");
  assert.ok(/header has been edited/.test(ov([{ op: "append", sheet: "Moves", rows: [REV("h2", M("r5"))] }]).error), "override too");
  assert.throws(() => ctx.ensureColumns_("Moves"), /column 4 should be 'sku'/);
  hdr[3] = good;
  assert.ok(app(TL, [M("h1")]).ok, "works again once the header is fixed");
  // a missing LAST header is still added automatically (older Sheet)
  hdr[17] = ""; assert.ok(app(TL, [M("h3")]).ok); assert.strictEqual(hdr[17], "approvedBy");
  console.log("backend fix round F1-F6: all tests passed");
}

// --- decidedAt is the Sheet's time, not the phone's ---
{
  const { ctx, post } = makeGas();
  ctx.setAdminPin_("482915", "482915");
  const A = post({ action: "login", username: "admin", pin: "482915" }).token;
  assert.ok(post({ action: "users", token: A, cmd: "save", isNew: true, user: { username: "lebo", name: "Lebo", role: "manager" }, pin: "580214" }).ok);
  let L = post({ action: "login", username: "lebo", pin: "580214" });
  if (L.user.mustChange) { assert.ok(post({ action: "changePin", token: L.token, oldPin: "580214", newPin: "690325" }).ok); L = post({ action: "login", username: "lebo", pin: "690325" }); }
  const LT = L.token;
  assert.ok(post({ token: A, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "CNT-T1", place: "WH", ts: new Date().toISOString(), status: "pending", lines: "[]", value: 0 }] }] }).ok);
  const before = Date.now();
  const r = post({ token: LT, ops: [{ op: "upsert", sheet: "Counts", rows: [{ id: "CNT-T1", status: "rejected", decidedAt: "2001-01-01T00:00:00.000Z", decisionNote: "recount" }], expect: { field: "status", values: ["pending"] } }] });
  assert.ok(r.ok, r.error);
  const c = post({ token: A }).data.Counts.find(x => x.id === "CNT-T1");
  assert.ok(Date.parse(c.decidedAt) >= before - 1000, "decidedAt stamped by the Sheet, phone's 2001 date ignored: " + c.decidedAt);
  assert.strictEqual(c.decidedBy, "lebo");
  console.log("backend decidedAt: all tests passed");
}
