// A small fake of Google Apps Script (Sheets, properties, lock, cache), so Code.gs
// can run in Node exactly as written. Used by the backend tests and the local test server.
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const path = require("path");

function makeGas() {
  const sheets = {}, props = {}, cache = {};
  function Sheet(name) {
    const rows = [];
    let maxRows = 1000;   // like a new Google Sheet tab: writing below the last row throws
    return {
      name, rows,
      getMaxRows: () => maxRows,
      insertRowsAfter(after, n) { maxRows += n; },
      getMaxColumns: () => 26,
      getLastRow: () => rows.length,
      setFrozenRows() {},
      deleteRow(r) { rows.splice(r - 1, 1); maxRows--; },
      deleteRows(r, n) { rows.splice(r - 1, n); maxRows -= n; },
      getRange(r, c, nr = 1, nc = 1) {
        if (r < 1 || c < 1 || r + nr - 1 > maxRows || c + nc - 1 > 26) throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
        return {
          setNumberFormat() { return this; },
          clearContent() { for (let i = 0; i < nr; i++) { const row = rows[r - 1 + i]; if (row) for (let j = 0; j < nc; j++) row[c - 1 + j] = ""; } return this; },
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
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => (cache[k] = v), remove: k => delete cache[k] }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac("sha256", String(key)).update(String(value), "utf8").digest()).map(b => (b > 127 ? b - 256 : b)),
      computeDigest: (alg, text) => Array.from(crypto.createHash(alg).update(String(text), "utf8").digest()).map(b => (b > 127 ? b - 256 : b))
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
    HtmlService: { createHtmlOutput: h => ({ body: h, setTitle() { return this; } }) },
    Date, JSON, Math, Object, String, Number
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8"), ctx);
  const adminPin = ctx.setup();
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  return { ctx, sheets, props, cache, adminPin, post, get: () => ctx.doGet({ parameter: {} }).body };
}
module.exports = { makeGas };
