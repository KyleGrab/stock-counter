/**
 * Stock Counter - Google Sheet backend (v1.1).
 *
 * Paste this whole file into Extensions > Apps Script of the Google Sheet,
 * run setup() once, then Deploy > New deployment > Web app. See SETUP.md.
 *
 * What this protects:
 *  - Secret key required on every request (sent in the request body, never in the link).
 *  - Movements (Moves tab) can only be ADDED, never changed or deleted.
 *  - The Sheet hands out job, sticker and van numbers, so two phones never clash.
 *  - Job steps are checked (a job can't be kitted or closed twice).
 *  - Stock in the store, vans and jobs can't go below zero.
 *  - Each save is all-or-nothing: everything is checked before anything is written.
 *  - A save that is retried after a dropped connection is only applied once.
 *  - Text that looks like a spreadsheet formula is stored as plain text.
 */

var VERSION = "1.1";

var SHEETS = {
  Items:  { key: "sku",  cols: ["sku", "name", "uom", "track", "cost", "reorder", "allowancePct"] },
  Jobs:   { key: "no",   cols: ["no", "client", "type", "van", "installer", "quoteRef", "status", "created", "kittedAt", "outAt", "closedAt", "missingValue", "reason"] },
  Lines:  { key: "id",   cols: ["id", "job", "sku", "quoted"] },
  Moves:  { key: "id",   cols: ["id", "ts", "type", "sku", "qty", "from", "to", "job", "van", "installer", "serial", "unitCost", "value", "ref", "reason", "by", "reverses"] },
  Labels: { key: "code", cols: ["code", "sku", "note"] },
  Vans:   { key: "id",   cols: ["id", "name"] },
  VanKit: { key: "sku",  cols: ["sku", "target"] }
};
var NUMBERING = { Jobs: { prefix: "J-", pad: 4, first: 1001 }, Labels: { prefix: "GS-", pad: 4, first: 1 }, Vans: { prefix: "VAN-", pad: 0, first: 1 } };

/* ---------------- setup ---------------- */

/** Run once from the editor. Creates the tabs and the secret key. Safe to run again. */
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

/* ---------------- web endpoints ---------------- */

/** Opening the link in a browser only says hello. No data is ever sent over GET. */
function doGet() {
  return json_({ ok: true, app: "Stock Counter", version: VERSION });
}

/**
 * Every read and write is one POST: { key, have, batch, ops }.
 *  have  = how many movements the phone already has (only newer ones are sent back)
 *  batch = a unique id for this save, so a retry is applied only once
 *  ops   = the changes to make
 */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    checkKey_(body.key);
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      var assigned = {};
      var ops = body.ops || [];
      if (ops.length) {
        var cache = CacheService.getScriptCache();
        var done = body.batch ? cache.get("b_" + body.batch) : null;
        if (done) assigned = JSON.parse(done);
        else {
          assigned = applyBatch_(ops);
          if (body.batch) cache.put("b_" + body.batch, JSON.stringify(assigned), 21600);
        }
        SpreadsheetApp.flush();
      }
      out = { ok: true, version: VERSION, assigned: assigned, data: readAll_(Number(body.have) || 0) };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return json_(out);
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function checkKey_(given) {
  var key = PropertiesService.getScriptProperties().getProperty("KEY");
  if (!key) throw new Error("Not set up. Run setup() in Apps Script first.");
  if (String(given || "") !== key) throw new Error("Wrong secret key. Check More → Settings in the app.");
}

/* ---------------- reading ---------------- */

function sheet_(name) {
  if (!SHEETS[name]) throw new Error("Unknown tab: " + name);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Tab missing: " + name + ". Run setup() again.");
  return sh;
}

function rows_(name, fromRow) {
  var sh = sheet_(name), cols = SHEETS[name].cols, start = 2 + (fromRow || 0), n = sh.getLastRow() - start + 1;
  if (n < 1) return [];
  return sh.getRange(start, 1, n, cols.length).getValues().filter(function (r) { return String(r[0]) !== ""; }).map(function (r) {
    var o = {};
    cols.forEach(function (c, i) { var v = r[i]; o[c] = v instanceof Date ? v.toISOString() : String(v); });
    return o;
  });
}

function readAll_(have) {
  var out = {};
  Object.keys(SHEETS).forEach(function (name) { if (name !== "Moves") out[name] = rows_(name, 0); });
  var total = Math.max(0, sheet_("Moves").getLastRow() - 1);
  var from = have > 0 && have <= total ? have : 0;  // if the phone is ahead or confused, send everything
  out.Moves = rows_("Moves", from);
  out.movesFrom = from;
  out.movesTotal = total;
  return out;
}

/* ---------------- writing ---------------- */

/**
 * Two phases. Phase 1 checks every operation against an in-memory copy and works out
 * new numbers. Nothing is written unless every check passes. Phase 2 writes.
 */
function applyBatch_(ops) {
  var mem = {};          // sheet -> { keys: [...], rows: {key: row} } loaded on demand
  function load(name) {
    if (mem[name]) return mem[name];
    var rows = rows_(name, 0), byKey = {}, k = SHEETS[name].key;
    rows.forEach(function (r) { byKey[String(r[k])] = r; });
    mem[name] = { keys: rows.map(function (r) { return String(r[k]); }), rows: byKey };
    return mem[name];
  }
  var assigned = {}, plan = [], newMoves = [];

  ops.forEach(function (raw) {
    var op = substitute_(raw, assigned);
    var def = SHEETS[op.sheet];
    if (!def) throw new Error("Unknown tab: " + op.sheet);

    if (op.op === "create") {
      var num = NUMBERING[op.sheet];
      if (!num) throw new Error("Numbers are only handed out for jobs, stickers and vans.");
      var m = load(op.sheet), max = num.first - 1;
      m.keys.forEach(function (k) {
        if (k.indexOf(num.prefix) !== 0) return;
        var n = parseInt(k.slice(num.prefix.length), 10);
        if (n > max) max = n;
      });
      var id = String(max + 1);
      while (id.length < num.pad) id = "0" + id;
      id = num.prefix + id;
      var row = Object.assign({}, op.row || {});
      row[def.key] = id;
      m.keys.push(id); m.rows[id] = row;
      if (op.ref) assigned[op.ref] = id;
      plan.push({ op: "insert", sheet: op.sheet, rows: [row] });
      return;
    }

    if (op.op === "append") {
      if (op.sheet !== "Moves") throw new Error("Append is only for Moves.");
      var seen = load("Moves").rows;
      var fresh = (op.rows || []).filter(function (r) {
        if (!r.id || !r.sku || !(Number(r.qty) > 0)) throw new Error("A movement is missing its id, item or quantity.");
        if (seen[String(r.id)]) return false;   // already saved by an earlier retry
        seen[String(r.id)] = r;
        return true;
      });
      newMoves = newMoves.concat(fresh);
      if (fresh.length) plan.push({ op: "insert", sheet: "Moves", rows: fresh });
      return;
    }

    if (op.sheet === "Moves") throw new Error("Movements can't be changed. Record a correction instead.");

    if (op.op === "upsert") {
      var mm = load(op.sheet);
      (op.rows || []).forEach(function (r) {
        var k = String(r[def.key] || "");
        if (!k) throw new Error("Missing " + def.key + " for " + op.sheet + ".");
        var cur = mm.rows[k];
        if (op.expect) {
          var field = op.expect.field, want = op.expect.values || [];
          var now = cur ? String(cur[field]) : "";
          if (want.indexOf(now) < 0) {
            throw new Error(op.sheet === "Jobs" ? "Job " + k + " was already moved on (now '" + (now || "missing") + "'), probably on another device. Refresh." : "Record " + k + " changed on another device. Refresh.");
          }
        }
        mm.rows[k] = Object.assign({}, cur || {}, r);
        if (!cur) mm.keys.push(k);
      });
      plan.push({ op: "upsert", sheet: op.sheet, rows: op.rows || [] });
      return;
    }

    if (op.op === "replaceLines") {
      if (op.sheet !== "Lines") throw new Error("replaceLines is only for Lines.");
      if (!op.job) throw new Error("Missing job.");
      var job = load("Jobs").rows[String(op.job)];
      if (job && job.status && job.status !== "quoted") throw new Error("Job " + op.job + " is already kitted. Its quote materials can't change now.");
      plan.push(op);
      return;
    }

    if (op.op === "remove") {
      if (["Labels", "VanKit", "Vans"].indexOf(op.sheet) < 0) throw new Error("Can't remove rows from " + op.sheet + ".");
      plan.push(op);
      return;
    }

    throw new Error("Unknown operation: " + op.op);
  });

  if (newMoves.length) {
    var problem = checkBalances_(newMoves);
    if (problem) throw new Error(problem);
  }

  plan.forEach(write_);
  return assigned;
}

/** Replace placeholders such as "$JOB" with the numbers handed out earlier in this save. */
function substitute_(op, assigned) {
  var refs = Object.keys(assigned);
  if (!refs.length) return op;
  return JSON.parse(JSON.stringify(op), function (k, v) {
    if (typeof v !== "string" || k === "ref") return v;
    refs.forEach(function (r) {
      // whole placeholder only: "$L" must not touch "$L2"
      v = v.replace(new RegExp(r.replace(/[$^.*+?()[\]{}|\\]/g, "\\$&") + "(?![A-Za-z0-9_])", "g"), assigned[r]);
    });
    return v;
  });
}

function isRealPlace_(loc) { return loc === "WH" || /^VAN-/.test(loc || "") || /^JOB:/.test(loc || ""); }

/** Same rule as checkBalances in core.js: real places can't go below zero. */
function checkBalances_(incoming) {
  var touched = {};
  incoming.forEach(function (m) { if (isRealPlace_(m.from)) touched[m.from + "|" + m.sku] = [m.from, m.sku]; });
  var keys = Object.keys(touched);
  if (!keys.length) return null;
  var want = {}; keys.forEach(function (k) { want[touched[k][1]] = true; });
  var sh = sheet_("Moves"), cols = SHEETS.Moves.cols, n = sh.getLastRow() - 1;
  var iS = cols.indexOf("sku"), iQ = cols.indexOf("qty"), iF = cols.indexOf("from"), iT = cols.indexOf("to");
  var B = {};
  function add(loc, sku, q) { var k = loc + "|" + sku; B[k] = Math.round(((B[k] || 0) + q) * 100) / 100; }
  if (n > 0) sh.getRange(2, 1, n, cols.length).getValues().forEach(function (r) {
    var sku = String(r[iS]); if (!want[sku]) return;
    var q = Number(r[iQ]) || 0;
    add(String(r[iF]), sku, -q); add(String(r[iT]), sku, q);
  });
  incoming.forEach(function (m) { var q = Number(m.qty) || 0; add(String(m.from), String(m.sku), -q); add(String(m.to), String(m.sku), q); });
  for (var i = 0; i < keys.length; i++) {
    var b = B[keys[i]] || 0;
    if (b < -0.005) {
      var loc = touched[keys[i]][0], where = loc === "WH" ? "the store" : loc.indexOf("JOB:") === 0 ? "job " + loc.slice(4) : loc;
      return "Not enough " + touched[keys[i]][1] + " in " + where + ". Someone may have used it on another device. Refresh and check.";
    }
  }
  return null;
}

/** Stop a typed value starting with = + @ being run as a spreadsheet formula. */
function safe_(v) {
  if (v === undefined || v === null) return "";
  var s = String(v);
  return /^[=+@]/.test(s) || /^-[^0-9.]/.test(s) ? "'" + s : s;
}
function toRow_(cols, obj) { return cols.map(function (c) { return safe_(obj[c]); }); }

function write_(step) {
  var def = SHEETS[step.sheet], sh = sheet_(step.sheet), cols = def.cols, rows = step.rows || [];

  if (step.op === "insert") {
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols.length).setValues(rows.map(function (r) { return toRow_(cols, r); }));
    return;
  }

  if (step.op === "upsert") {
    var keyIdx = cols.indexOf(def.key), n = sh.getLastRow() - 1;
    var keys = n > 0 ? sh.getRange(2, keyIdx + 1, n, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    rows.forEach(function (r) {
      var k = String(r[def.key]), at = keys.indexOf(k);
      if (at >= 0) {
        // Merge: only overwrite the fields that were sent.
        var range = sh.getRange(at + 2, 1, 1, cols.length), cur = range.getValues()[0];
        range.setValues([cols.map(function (c, i) { return r.hasOwnProperty(c) ? safe_(r[c]) : cur[i]; })]);
      } else {
        sh.getRange(sh.getLastRow() + 1, 1, 1, cols.length).setValues([toRow_(cols, r)]);
        keys.push(k);
      }
    });
    return;
  }

  if (step.op === "replaceLines") {
    var last = sh.getLastRow(), job = String(step.job);
    if (last > 1) {
      var vals = sh.getRange(2, cols.indexOf("job") + 1, last - 1, 1).getValues();
      for (var i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]) === job) sh.deleteRow(i + 2);
    }
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols.length).setValues(rows.map(function (r) { return toRow_(cols, r); }));
    return;
  }

  if (step.op === "remove") {
    var kIdx = cols.indexOf(def.key) + 1, last2 = sh.getLastRow();
    if (last2 < 2) return;
    var ks = sh.getRange(2, kIdx, last2 - 1, 1).getValues(), del = {};
    rows.forEach(function (r) { del[String(r[def.key])] = true; });
    for (var j = ks.length - 1; j >= 0; j--) if (del[String(ks[j][0])]) sh.deleteRow(j + 2);
  }
}
