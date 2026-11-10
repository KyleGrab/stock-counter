/**
 * Stock Counter - Google Sheet backend.
 *
 * Paste this whole file into Extensions > Apps Script of the Google Sheet,
 * run setup() once, then Deploy > New deployment > Web app.
 * The SETUP guide walks through every click.
 *
 * Rules this backend enforces:
 *  - Every request must carry the secret key created by setup().
 *  - Movements (the Moves tab) can only be ADDED, never changed or deleted.
 *  - Only the tabs listed below can be touched.
 *  - One request at a time (a lock), so two phones can't overwrite each other mid-save.
 */

var SHEETS = {
  Items:  { key: "sku",  cols: ["sku", "name", "uom", "track", "cost", "reorder", "allowancePct"] },
  Jobs:   { key: "no",   cols: ["no", "client", "type", "van", "installer", "quoteRef", "status", "created", "kittedAt", "outAt", "closedAt", "missingValue", "reason"] },
  Lines:  { key: "id",   cols: ["id", "job", "sku", "quoted"] },
  Moves:  { key: null,   cols: ["id", "ts", "type", "sku", "qty", "from", "to", "job", "van", "installer", "serial", "unitCost", "value", "ref", "reason", "by"] },
  Labels: { key: "code", cols: ["code", "sku", "note"] },
  Vans:   { key: "id",   cols: ["id", "name"] },
  VanKit: { key: "sku",  cols: ["sku", "target"] }
};

/** Run this once from the editor. Creates the tabs and the secret key. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SHEETS[name].cols;
    // Plain text everywhere, so serial numbers and dates are kept exactly as typed.
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat("@");
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold");
    sh.setFrozenRows(1);
  });
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty("KEY");
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, "").slice(0, 20);
    props.setProperty("KEY", key);
  }
  var first = ss.getSheetByName("Sheet1");
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  Logger.log("Setup done. Your secret key is: " + key);
  return key;
}

/** Shows the secret key again if you lose it. */
function showKey() {
  Logger.log("Secret key: " + PropertiesService.getScriptProperties().getProperty("KEY"));
}

function doGet(e) {
  return handle_(function () {
    checkKey_(e.parameter.key);
    if (e.parameter.action === "ping") return { ok: true };
    return { ok: true, data: readAll_() };
  });
}

function doPost(e) {
  return handle_(function () {
    var body = JSON.parse(e.postData.contents);
    checkKey_(body.key);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      (body.ops || []).forEach(applyOp_);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return { ok: true, data: readAll_() };
  });
}

function handle_(fn) {
  var out;
  try { out = fn(); }
  catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(given) {
  var key = PropertiesService.getScriptProperties().getProperty("KEY");
  if (!key) throw new Error("Not set up. Run setup() in Apps Script first.");
  if (String(given || "") !== key) throw new Error("Wrong secret key. Check Settings in the app.");
}

function sheet_(name) {
  if (!SHEETS[name]) throw new Error("Unknown tab: " + name);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Tab missing: " + name + ". Run setup() again.");
  return sh;
}

function readAll_() {
  var out = {};
  Object.keys(SHEETS).forEach(function (name) {
    var sh = sheet_(name), cols = SHEETS[name].cols, n = sh.getLastRow() - 1;
    if (n < 1) { out[name] = []; return; }
    var vals = sh.getRange(2, 1, n, cols.length).getValues();
    out[name] = vals.filter(function (r) { return String(r[0]) !== ""; }).map(function (r) {
      var o = {};
      cols.forEach(function (c, i) {
        var v = r[i];
        o[c] = v instanceof Date ? v.toISOString() : String(v);
      });
      return o;
    });
  });
  return out;
}

function toRow_(cols, obj) {
  return cols.map(function (c) { var v = obj[c]; return v === undefined || v === null ? "" : String(v); });
}

function applyOp_(op) {
  var def = SHEETS[op.sheet];
  if (!def) throw new Error("Unknown tab: " + op.sheet);
  var sh = sheet_(op.sheet), cols = def.cols;
  var rows = op.rows || [];

  if (op.op === "append") {
    if (op.sheet !== "Moves") throw new Error("Append is only for Moves.");
    if (!rows.length) return;
    rows.forEach(function (r) { if (!r.id || !r.sku || !(Number(r.qty) > 0)) throw new Error("Movement is missing id, item or quantity."); });
    // Skip any movement already saved (a retry after a dropped connection).
    var have = {};
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
    var fresh = rows.filter(function (r) { return !have[String(r.id)]; });
    if (!fresh.length) return;
    sh.getRange(sh.getLastRow() + 1, 1, fresh.length, cols.length).setValues(fresh.map(function (r) { return toRow_(cols, r); }));
    return;
  }

  if (op.sheet === "Moves") throw new Error("Movements can't be changed. Record a correcting movement instead.");

  if (op.op === "upsert") {
    var keyIdx = cols.indexOf(def.key);
    var n = sh.getLastRow() - 1;
    var keys = n > 0 ? sh.getRange(2, keyIdx + 1, n, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    rows.forEach(function (r) {
      var k = String(r[def.key] || "");
      if (!k) throw new Error("Missing " + def.key + " for " + op.sheet);
      var at = keys.indexOf(k);
      if (at >= 0) {
        // Merge: only overwrite the fields that were sent.
        var range = sh.getRange(at + 2, 1, 1, cols.length);
        var cur = range.getValues()[0];
        var merged = cols.map(function (c, i) { return r.hasOwnProperty(c) ? (r[c] == null ? "" : String(r[c])) : cur[i]; });
        range.setValues([merged]);
      } else {
        sh.getRange(sh.getLastRow() + 1, 1, 1, cols.length).setValues([toRow_(cols, r)]);
        keys.push(k);
      }
    });
    return;
  }

  if (op.op === "replaceLines") {
    if (op.sheet !== "Lines") throw new Error("replaceLines is only for Lines.");
    var job = String(op.job || "");
    if (!job) throw new Error("Missing job.");
    var last = sh.getLastRow();
    if (last > 1) {
      var jobCol = cols.indexOf("job") + 1;
      var vals = sh.getRange(2, jobCol, last - 1, 1).getValues();
      for (var i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]) === job) sh.deleteRow(i + 2);
    }
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols.length).setValues(rows.map(function (r) { return toRow_(cols, r); }));
    return;
  }

  if (op.op === "remove") {
    if (["Labels", "VanKit", "Vans"].indexOf(op.sheet) < 0) throw new Error("Can't remove rows from " + op.sheet);
    var kIdx = cols.indexOf(def.key) + 1, last2 = sh.getLastRow();
    if (last2 < 2) return;
    var ks = sh.getRange(2, kIdx, last2 - 1, 1).getValues();
    var del = {}; rows.forEach(function (r) { del[String(r[def.key])] = true; });
    for (var j = ks.length - 1; j >= 0; j--) if (del[String(ks[j][0])]) sh.deleteRow(j + 2);
    return;
  }

  throw new Error("Unknown operation: " + op.op);
}
