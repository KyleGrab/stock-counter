// Runs Code.gs against a fake Google Sheet, to check the backend rules without Google.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function makeEnv() {
  const sheets = {};
  const props = {};
  function Sheet(name) {
    const rows = []; // rows[r][c], 0-based
    const self = {
      name,
      rows,
      getMaxRows: () => 1000,
      getLastRow: () => rows.length,
      setFrozenRows() {},
      deleteRow(r) { rows.splice(r - 1, 1); },
      getRange(r, c, nr = 1, nc = 1) {
        if (typeof r === "string") return { setNumberFormat() { return this; } };
        return {
          setNumberFormat() { return this; },
          setFontWeight() { return this; },
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) { const row = rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] ?? ""); out.push(o); }
            return out;
          },
          setValues(vals) {
            vals.forEach((v, i) => { const ri = r - 1 + i; rows[ri] = rows[ri] || []; v.forEach((x, j) => { rows[ri][c - 1 + j] = x; }); });
            return this;
          }
        };
      }
    };
    return self;
  }
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = Sheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => delete sheets[s.name]
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => (props[k] = v) }) },
    Utilities: { getUuid: () => "abcd-1234-efgh-5678-ijkl-9999" },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
    Date
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + "/../Code.gs", "utf8"), ctx);
  return { ctx, sheets };
}

const { ctx, sheets } = makeEnv();
const key = ctx.setup();
assert.ok(key && key.length === 20);
assert.deepStrictEqual(sheets.Moves.rows[0].slice(0, 3), ["id", "ts", "type"]);

const get = p => JSON.parse(ctx.doGet({ parameter: p }).body);
const post = b => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).body);

assert.strictEqual(get({ key: "wrong" }).ok, false, "wrong key rejected");
assert.strictEqual(get({ key, action: "ping" }).ok, true);

// upsert an item, then update one field only
let r = post({ key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV6-RED", name: "PV red", uom: "m", track: "qty", cost: 18.5 }] }] });
assert.ok(r.ok, r.error);
r = post({ key, ops: [{ op: "upsert", sheet: "Items", rows: [{ sku: "PV6-RED", cost: 19 }] }] });
assert.strictEqual(r.data.Items[0].name, "PV red", "merge keeps other fields");
assert.strictEqual(r.data.Items[0].cost, "19");

// append moves, retry is ignored
const mv = { id: "m1", ts: "2026-11-10T10:00:00.000Z", type: "receive", sku: "PV6-RED", qty: 100, from: "SUPPLIER", to: "WH" };
post({ key, ops: [{ op: "append", sheet: "Moves", rows: [mv] }] });
r = post({ key, ops: [{ op: "append", sheet: "Moves", rows: [mv] }] });
assert.strictEqual(r.data.Moves.length, 1, "duplicate id not saved twice");
assert.strictEqual(r.data.Moves[0].ts, "2026-11-10T10:00:00.000Z");

// moves can't be edited
r = post({ key, ops: [{ op: "upsert", sheet: "Moves", rows: [mv] }] });
assert.strictEqual(r.ok, false);
// bad movement rejected
r = post({ key, ops: [{ op: "append", sheet: "Moves", rows: [{ id: "m2", sku: "X", qty: 0 }] }] });
assert.strictEqual(r.ok, false);
// unknown tab rejected
assert.strictEqual(post({ key, ops: [{ op: "upsert", sheet: "Secrets", rows: [{}] }] }).ok, false);

// replace job lines
post({ key, ops: [{ op: "replaceLines", sheet: "Lines", job: "J-1001", rows: [{ id: "J-1001|A", job: "J-1001", sku: "A", quoted: 1 }, { id: "J-1001|B", job: "J-1001", sku: "B", quoted: 2 }] },
                  { op: "replaceLines", sheet: "Lines", job: "J-1002", rows: [{ id: "J-1002|A", job: "J-1002", sku: "A", quoted: 5 }] }] });
r = post({ key, ops: [{ op: "replaceLines", sheet: "Lines", job: "J-1001", rows: [{ id: "J-1001|C", job: "J-1001", sku: "C", quoted: 3 }] }] });
assert.deepStrictEqual(r.data.Lines.map(l => l.id).sort(), ["J-1001|C", "J-1002|A"]);

// remove allowed only on small lists
post({ key, ops: [{ op: "upsert", sheet: "Labels", rows: [{ code: "GS-0001", sku: "A" }, { code: "GS-0002", sku: "B" }] }] });
r = post({ key, ops: [{ op: "remove", sheet: "Labels", rows: [{ code: "GS-0001" }] }] });
assert.deepStrictEqual(r.data.Labels.map(l => l.code), ["GS-0002"]);
assert.strictEqual(post({ key, ops: [{ op: "remove", sheet: "Jobs", rows: [{ no: "J-1" }] }] }).ok, false);

console.log("backend: all tests passed");
