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
