// A small fake of Google Apps Script (Sheets, properties, lock, cache), so Code.gs
// can run in Node exactly as written. Used by the backend tests and the local test server.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function makeGas() {
  const sheets = {}, props = {}, cache = {};
  function Sheet(name) {
    const rows = [];
    return {
      name, rows,
      getMaxRows: () => 1000,
      getMaxColumns: () => 26,
      getLastRow: () => rows.length,
      setFrozenRows() {},
      deleteRow(r) { rows.splice(r - 1, 1); },
      getRange(r, c, nr = 1, nc = 1) {
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
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => (cache[k] = v) }) },
    Utilities: { getUuid: () => "abcd-1234-efgh-5678-ijkl-9999" },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
    Date, JSON, Math, Object, String, Number
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8"), ctx);
  const key = ctx.setup();
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, sheets, key, post, get: () => JSON.parse(ctx.doGet({ parameter: {} }).body) };
}
module.exports = { makeGas };
