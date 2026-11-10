// Runs Code.gs against a fake Google Sheet, to check the backend rules without Google.
const assert = require("assert");
const { makeGas } = require("./fake-gas");
const { sheets, key, post, get } = makeGas();

assert.ok(key && key.length === 20);
assert.deepStrictEqual(sheets.Moves.rows[0].slice(0, 3), ["id", "ts", "type"]);

// GET gives no data, only a hello
const hello = get();
assert.strictEqual(hello.ok, true); assert.strictEqual(hello.data, undefined);

// wrong key
assert.strictEqual(post({ key: "wrong" }).ok, false);
// plain read
assert.strictEqual(post({ key }).ok, true);

// items: upsert, then merge one field
let r = post({ key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", name: "PV red", uom: "m", track: "qty", cost: 18.5 }] }] });
assert.ok(r.ok, r.error);
r = post({ key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV", cost: 19 }] }] });
assert.strictEqual(r.data.Items[0].name, "PV red", "merge keeps other fields");

// the Sheet hands out job numbers, and placeholders are filled in later ops
r = post({ key, ops: [
  { op: "create", sheet: "Jobs", ref: "$JOB", row: { client: "A", status: "quoted" } },
  { op: "replaceLines", sheet: "Lines", job: "$JOB", rows: [{ id: "$JOB|PV", job: "$JOB", sku: "PV", quoted: 30 }] }] });
assert.ok(r.ok, r.error);
assert.strictEqual(r.assigned.$JOB, "J-1001");
assert.strictEqual(r.data.Lines[0].id, "J-1001|PV");
r = post({ key, ops: [{ op: "create", sheet: "Jobs", ref: "$JOB", row: { client: "B", status: "quoted" } }] });
assert.strictEqual(r.assigned.$JOB, "J-1002", "second job gets the next number, never a clash");
r = post({ key, ops: [{ op: "create", sheet: "Labels", ref: "$L", row: { sku: "PV" } }, { op: "create", sheet: "Labels", ref: "$L2", row: { sku: "PV" } }] });
assert.deepStrictEqual([r.assigned.$L, r.assigned.$L2], ["GS-0001", "GS-0002"]);

// stock: receive 100, issue 80 OK, issue 30 more refused (only 20 left)
const mv = (id, qty, from, to, x) => Object.assign({ id, ts: "2026-11-10T10:00:00.000Z", type: "kit", sku: "PV", qty, from, to }, x || {});
r = post({ key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m1", 100, "SUPPLIER", "WH", { type: "receive" })] }] });
assert.ok(r.ok, r.error);
r = post({ key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m2", 80, "WH", "JOB:J-1001")] }, { op: "upsert", sheet: "Jobs", rows: [{ no: "J-1001", status: "kitted" }], expect: { field: "status", values: ["quoted"] } }] });
assert.ok(r.ok, r.error);
r = post({ key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m3", 30, "WH", "JOB:J-1002")] }] });
assert.strictEqual(r.ok, false); assert.ok(/Not enough/.test(r.error));

// job step check: kitting J-1001 again is refused, and NOTHING from that save is written (all-or-nothing)
const before = sheets.Moves.rows.length;
r = post({ key, ops: [{ op: "append", sheet: "Moves", rows: [mv("m4", 5, "WH", "JOB:J-1001")] }, { op: "upsert", sheet: "Jobs", rows: [{ no: "J-1001", status: "kitted" }], expect: { field: "status", values: ["quoted"] } }] });
assert.strictEqual(r.ok, false); assert.ok(/already moved on/.test(r.error));
assert.strictEqual(sheets.Moves.rows.length, before, "refused save wrote nothing");

// quote lines can't change after kitting
r = post({ key, ops: [{ op: "replaceLines", sheet: "Lines", job: "J-1001", rows: [] }] });
assert.strictEqual(r.ok, false);

// retry safety: same batch id twice is applied once; same movement id twice saved once
const batch = { key, batch: "b-123", ops: [{ op: "append", sheet: "Moves", rows: [mv("m5", 3, "JOB:J-1001", "WH", { type: "return" })] }] };
assert.ok(post(batch).ok);
r = post(batch);
assert.ok(r.ok);
assert.strictEqual(sheets.Moves.rows.filter(x => x[0] === "m5").length, 1);
r = post({ key, batch: "b-other", ops: batch.ops });
assert.strictEqual(sheets.Moves.rows.filter(x => x[0] === "m5").length, 1);

// incremental sync: phone has 2 movements -> only the newer ones come back
r = post({ key, have: 2 });
assert.strictEqual(r.data.movesFrom, 2); assert.strictEqual(r.data.Moves.length, r.data.movesTotal - 2);
r = post({ key, have: 999 });
assert.strictEqual(r.data.movesFrom, 0, "phone ahead of the sheet -> full resend");

// movements can't be edited; unknown tabs and bad removes refused
assert.strictEqual(post({ key, ops: [{ op: "upsert", sheet: "Moves", rows: [{ id: "m1" }] }] }).ok, false);
assert.strictEqual(post({ key, ops: [{ op: "upsert", sheet: "Secrets", rows: [{}] }] }).ok, false);
assert.strictEqual(post({ key, ops: [{ op: "remove", sheet: "Jobs", rows: [{ no: "J-1" }] }] }).ok, false);
assert.strictEqual(post({ key, ops: [{ op: "append", sheet: "Moves", rows: [{ id: "x", sku: "PV", qty: 0 }] }] }).ok, false);

// formula guard
post({ key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "EVIL", name: "=IMPORTXML(\"http://x\")" }] }] });
assert.ok(sheets.Items.rows.some(row => row[1] === "'=IMPORTXML(\"http://x\")"));

console.log("backend: all tests passed");
