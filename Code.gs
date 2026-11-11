/**
 * Stock Counter - Google Sheet backend (v1.2).
 *
 * Paste this whole file into Extensions > Apps Script of the Google Sheet,
 * run setup() once, then Deploy > New deployment > Web app. See SETUP.md.
 *
 * What this protects:
 *  - Everyone signs in with a username and PIN. PINs are stored hashed, never readable.
 *    5 wrong PINs locks that login for 15 minutes. Sign-ins last 30 days per device.
 *  - Roles are enforced HERE, not just in the app:
 *      Senior Admin (admin)          everything, including logins
 *      Warehouse Manager (manager)   everything except logins: inventory, items, costs, corrections
 *      User (storeman)               daily stock work; shelf counts go for approval
 *      Viewer (viewer)               look only
 *  - Only a Senior Admin or Warehouse Manager can change store stock levels.
 *    A count is approved once, and never by the person who counted.
 *  - Every movement is stamped with the signed-in user, so names can't be faked.
 *  - Movements (Moves tab) can only be ADDED, never changed or deleted.
 *  - The Sheet hands out job, sticker and van numbers, so two phones never clash.
 *  - Job steps are checked (a job can't be kitted or closed twice).
 *  - Stock in the store, vans and jobs can't go below zero.
 *  - Each save is all-or-nothing, and a retried save is applied only once.
 *  - Text that looks like a spreadsheet formula is stored as plain text.
 */

var VERSION = "1.4";

var SHEETS = {
  Items:    { key: "sku",  cols: ["sku", "name", "uom", "track", "cost", "reorder", "allowancePct"] },
  Jobs:     { key: "no",   cols: ["no", "client", "type", "van", "installer", "quoteRef", "status", "created", "kittedAt", "outAt", "closedAt", "missingValue", "reason"] },
  Lines:    { key: "id",   cols: ["id", "job", "sku", "quoted"] },
  Moves:    { key: "id",   cols: ["id", "ts", "type", "sku", "qty", "from", "to", "job", "van", "installer", "serial", "unitCost", "value", "ref", "reason", "by", "reverses"] },
  Labels:   { key: "code", cols: ["code", "sku", "note"] },
  Vans:     { key: "id",   cols: ["id", "name"] },
  VanKit:   { key: "sku",  cols: ["sku", "target"] },
  Counts:   { key: "id",   cols: ["id", "place", "ts", "by", "status", "lines", "value", "note", "decidedBy", "decidedAt", "decisionNote"] },
  // Private: never sent to any phone.
  Users:    { key: "username", cols: ["username", "name", "role", "active", "mustChange", "salt", "pinHash", "created", "lastLogin"], private: true },
  Sessions: { key: "tokenHash", cols: ["tokenHash", "username", "created", "expires"], private: true }
};
var NUMBERING = { Jobs: { prefix: "J-", pad: 4, first: 1001 }, Labels: { prefix: "GS-", pad: 4, first: 1 }, Vans: { prefix: "VAN-", pad: 0, first: 1 } };
// admin = Senior Admin, manager = Warehouse Manager, storeman = User, viewer = Viewer (look only)
var ROLES = ["admin", "manager", "storeman", "viewer"];
function isManagerRole_(r) { return r === "admin" || r === "manager"; }
var SESSION_DAYS = 30, MAX_TRIES = 5, LOCK_MINUTES = 15;

/* ---------------- setup ---------------- */

/** Run once from the editor. Creates the tabs and the first admin login. Safe to run again. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SHEETS[name].cols;
    // Plain text everywhere, so serial numbers and dates are kept exactly as typed.
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat("@");
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold");
    sh.setFrozenRows(1);
    if (SHEETS[name].private && sh.hideSheet) sh.hideSheet();
  });
  var first = ss.getSheetByName("Sheet1");
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  if (rows_("Users", 0).length) { Logger.log("Setup checked. Users already exist."); return null; }
  var pin = randomPin_(6);
  writeUser_({ username: "admin", name: "Admin", role: "admin", active: "yes", mustChange: "yes", created: new Date().toISOString() }, pin);
  Logger.log("Setup done. First login -> username: admin   PIN: " + pin + "   (you'll be asked to choose your own PIN). Easier: reload the spreadsheet and use the menu Stock Counter -> Set admin PIN… to choose your own.");
  return pin;
}

/** Locked out of every admin login? Run this: the 'admin' login gets a new PIN. */
function resetAdmin() {
  var pin = randomPin_(6);
  writeUser_({ username: "admin", name: "Admin", role: "admin", active: "yes", mustChange: "yes" }, pin);
  endSessions_("admin");
  CacheService.getScriptCache().remove("fail_admin");
  Logger.log("Admin reset -> username: admin   PIN: " + pin);
  return pin;
}

/* ---------------- spreadsheet menu ---------------- */

/** Adds a "Stock Counter" menu to the spreadsheet. Runs by itself when the spreadsheet opens. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Stock Counter")
    .addItem("Set admin PIN…", "menuSetAdminPin")
    .addItem("Check admin login", "menuCheckAdmin")
    .addToUi();
}

/** Menu: type a PIN of your choice in a pop-up (twice). No log, nothing to copy. */
function menuSetAdminPin() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt("Set admin PIN", "Type a new PIN for the 'admin' login (6 to 8 digits, not 123456 or all the same digit):", ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var b = ui.prompt("Set admin PIN", "Type the same PIN again:", ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  try {
    var msg = setAdminPin_(a.getResponseText(), b.getResponseText());
    ui.alert("Done", msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("PIN not changed", String(err && err.message || err), ui.ButtonSet.OK);
  }
}

/** Sets the admin PIN directly (no temporary PIN), switches the login on, clears any lockout. */
function setAdminPin_(pin, again) {
  pin = cleanPin_(pin);
  if (pin !== cleanPin_(again)) throw fail_("The two PINs don't match. Nothing was changed.");
  checkPinRules_(pin, "admin");
  if (!rows_("Users", 0).length && !SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users")) throw fail_("Run setup first.");
  var cur = findUser_("admin");
  writeUser_({ username: "admin", name: cur ? cur.name : "Admin", role: "admin", active: "yes", mustChange: "no", created: cur ? undefined : new Date().toISOString() }, pin);
  endSessions_("admin");
  CacheService.getScriptCache().remove("fail_admin");
  return "The 'admin' login now uses the PIN you typed. Sign in on the phone with username admin and that PIN.";
}

/** Menu: shows the state of the admin login without revealing anything secret. */
function menuCheckAdmin() {
  SpreadsheetApp.getUi().alert("Admin login", adminStatus_(), SpreadsheetApp.getUi().ButtonSet.OK);
}
function adminStatus_() {
  var u = findUser_("admin");
  if (!u) return "There is no 'admin' login. Use Stock Counter → Set admin PIN… to create it.";
  var tries = Number(CacheService.getScriptCache().get("fail_admin") || 0);
  var admins = rows_("Users", 0).filter(function (x) { return x.role === "admin" && x.active === "yes"; }).map(function (x) { return x.username; });
  var sessions = rows_("Sessions", 0).filter(function (x) { return x.username === "admin" && x.expires > new Date().toISOString(); }).length;
  return [
    "Username: admin",
    "Switched on: " + (u.active === "yes" ? "yes" : "NO (switched off)"),
    "PIN set: " + (u.pinHash ? "yes" : "NO"),
    "Must choose own PIN at next sign-in: " + (u.mustChange === "yes" ? "yes" : "no"),
    "Wrong PIN tries just now: " + tries + (tries >= MAX_TRIES ? " (LOCKED for up to " + LOCK_MINUTES + " minutes; Set admin PIN… unlocks it)" : ""),
    "Signed in on: " + sessions + " device(s)",
    "Last sign-in: " + (u.lastLogin || "never"),
    "Active admin logins: " + admins.join(", ")
  ].join("\n");
}

/* ---------------- web endpoints ---------------- */

/** Opening the link in a browser shows a short page. No data is ever sent over GET. */
function doGet() {
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;line-height:1.5">' +
    "<h2>Stock Counter connection link</h2>" +
    "<p>This link connects the Stock Counter app to this Google Sheet. It is working (version " + VERSION + ").</p>" +
    "<p>Don't open it in a browser to use the app. Instead, open the app and paste this link into <b>Google Sheet web app link</b> on the sign-in page.</p></div>"
  ).setTitle("Stock Counter connection");
}

/**
 * Every request is one POST with an "action":
 *  login     { username, pin }                 -> { token, user }
 *  sync      { token, have, batch, ops }       -> { data, assigned, user }   (read + write)
 *  changePin { token, oldPin, newPin }
 *  logout    { token }
 *  users     { token, cmd, ... }               admin only: save / resetPin
 */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || "sync";
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      if (action === "login") out = login_(body);
      else {
        var user = auth_(body.token, action);
        if (action === "sync") out = sync_(body, user);
        else if (action === "changePin") out = changePin_(body, user);
        else if (action === "logout") { endSession_(body.token); out = { ok: true }; }
        else if (action === "users") out = users_(body, user);
        else throw new Error("Unknown request.");
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), signIn: !!(err && err.signIn) };
  }
  return json_(out);
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(msg, signIn) { var e = new Error(msg); e.signIn = !!signIn; return e; }

function sync_(body, user) {
  var assigned = {};
  var ops = body.ops || [];
  if (ops.length) {
    var cache = CacheService.getScriptCache();
    var done = body.batch ? cache.get("b_" + body.batch) : null;
    if (done) assigned = JSON.parse(done);
    else {
      assigned = applyBatch_(ops, user);
      if (body.batch) cache.put("b_" + body.batch, JSON.stringify(assigned), 21600);
    }
    SpreadsheetApp.flush();
  }
  var data = readAll_(Number(body.have) || 0);
  if (user.role === "admin") data.Users = publicUsers_();
  return { ok: true, version: VERSION, assigned: assigned, data: data, user: publicUser_(user) };
}

/* ---------------- logins ---------------- */

function hash_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var h = ((b + 256) % 256).toString(16); return h.length === 1 ? "0" + h : h; }).join("");
}
function randomPin_(len) {
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""), pin = "";
  for (var i = 0; pin.length < len; i++) pin += String(parseInt(hex.charAt(i % hex.length), 16) % 10);
  try { checkPinRules_(pin, "admin"); return pin; } catch (e) { return randomPin_(len); }
}
function cleanPin_(p) { return String(p == null ? "" : p).replace(/\s+/g, ""); }
function cleanName_(u) { return String(u || "").trim().toLowerCase(); }
function publicUser_(u) { return { username: u.username, name: u.name, role: u.role, mustChange: u.mustChange === "yes" }; }
function publicUsers_() {
  return rows_("Users", 0).map(function (u) { return { username: u.username, name: u.name, role: u.role, active: u.active, mustChange: u.mustChange, lastLogin: u.lastLogin }; });
}
function findUser_(username) {
  var k = cleanName_(username);
  return rows_("Users", 0).filter(function (u) { return u.username === k; })[0] || null;
}
function checkPinRules_(pin, role) {
  var min = isManagerRole_(role) ? 6 : 4;
  if (!/^\d+$/.test(String(pin || "")) || String(pin).length < min || String(pin).length > 8)
    throw fail_("PIN must be " + min + " to 8 digits" + (isManagerRole_(role) ? " for managers and admins." : "."));
  if (/^(\d)\1+$/.test(pin) || "0123456789".indexOf(pin) >= 0 || "9876543210".indexOf(pin) >= 0)
    throw fail_("Choose a PIN that isn't all the same digit or a simple run like 1234.");
}
function writeUser_(u, pin) {
  var row = { username: cleanName_(u.username) };
  ["name", "role", "active", "mustChange", "created", "lastLogin"].forEach(function (k) { if (u[k] !== undefined) row[k] = u[k]; });
  if (pin != null) { var salt = Utilities.getUuid(); row.salt = salt; row.pinHash = hash_(salt + ":" + pin); }
  write_({ op: "upsert", sheet: "Users", rows: [row] });
}
function endSessions_(username) {
  var k = cleanName_(username);
  var keep = rows_("Sessions", 0).filter(function (s) { return s.username === k; }).map(function (s) { return { tokenHash: s.tokenHash }; });
  if (keep.length) write_({ op: "remove", sheet: "Sessions", rows: keep });
}
function endSession_(token) { if (token) write_({ op: "remove", sheet: "Sessions", rows: [{ tokenHash: hash_(String(token)) }] }); }

function login_(body) {
  var name = cleanName_(body.username), cache = CacheService.getScriptCache(), fk = "fail_" + name;
  var tries = Number(cache.get(fk) || 0);
  if (tries >= MAX_TRIES) throw fail_("Too many wrong PINs. This login is locked for " + LOCK_MINUTES + " minutes, or an admin can reset the PIN.");
  var u = findUser_(name);
  var ok = u && u.active === "yes" && u.pinHash === hash_(u.salt + ":" + cleanPin_(body.pin));
  if (!ok) {
    cache.put(fk, String(tries + 1), LOCK_MINUTES * 60);
    var left = MAX_TRIES - tries - 1;
    throw fail_(u && u.active !== "yes" ? "This login has been switched off. Ask an admin." : "Wrong username or PIN." + (left > 0 && left <= 2 ? " " + left + " tries left." : ""));
  }
  cache.remove(fk);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  var nowD = new Date();
  write_({ op: "insert", sheet: "Sessions", rows: [{ tokenHash: hash_(token), username: u.username, created: nowD.toISOString(),
    expires: new Date(nowD.getTime() + SESSION_DAYS * 864e5).toISOString() }] });
  write_({ op: "upsert", sheet: "Users", rows: [{ username: u.username, lastLogin: nowD.toISOString() }] });
  // tidy expired sign-ins
  var old = rows_("Sessions", 0).filter(function (s) { return s.expires < nowD.toISOString(); }).map(function (s) { return { tokenHash: s.tokenHash }; });
  if (old.length) write_({ op: "remove", sheet: "Sessions", rows: old });
  return { ok: true, token: token, user: publicUser_(u) };
}

function auth_(token, action) {
  if (!token) throw fail_("Please sign in.", true);
  var th = hash_(String(token));
  var s = rows_("Sessions", 0).filter(function (x) { return x.tokenHash === th; })[0];
  if (!s || s.expires < new Date().toISOString()) throw fail_("Your sign-in has expired. Please sign in again.", true);
  var u = findUser_(s.username);
  if (!u || u.active !== "yes") throw fail_("This login has been switched off. Ask an admin.", true);
  if (u.mustChange === "yes" && action !== "changePin" && action !== "logout") throw fail_("Choose your own PIN first.", true);
  return u;
}

function changePin_(body, user) {
  var oldPin = cleanPin_(body.oldPin), newPin = cleanPin_(body.newPin);
  if (user.pinHash !== hash_(user.salt + ":" + oldPin)) throw fail_("Your current PIN is wrong.");
  checkPinRules_(newPin, user.role);
  if (newPin === oldPin) throw fail_("Choose a different PIN from the current one.");
  writeUser_({ username: user.username, mustChange: "no" }, newPin);
  return { ok: true, user: publicUser_(Object.assign({}, user, { mustChange: "no" })) };
}

/** Admin: create/update a login, or reset a PIN. */
function users_(body, me) {
  if (me.role !== "admin") throw fail_("Only a Senior Admin can manage logins.");
  var all = rows_("Users", 0);
  var activeAdmins = function (list) { return list.filter(function (u) { return u.role === "admin" && u.active === "yes"; }).length; };
  if (body.cmd === "save") {
    var u = body.user || {}, name = cleanName_(u.username);
    if (!/^[a-z0-9._-]{2,30}$/.test(name)) throw fail_("Username: 2 to 30 letters, numbers, dots or dashes. No spaces.");
    if (ROLES.indexOf(u.role) < 0) throw fail_("Choose a role.");
    if (!String(u.name || "").trim()) throw fail_("Add the person's name.");
    var cur = all.filter(function (x) { return x.username === name; })[0];
    if (!cur && body.isNew === false) throw fail_("That login no longer exists.");
    if (cur && body.isNew) throw fail_("That username is taken. Choose another.");
    var active = u.active === "no" ? "no" : "yes";
    var after = all.filter(function (x) { return x.username !== name; }).concat([{ username: name, role: u.role, active: active }]);
    if (activeAdmins(after) < 1) throw fail_("There must always be at least one active admin.");
    if (name === me.username && (active === "no" || u.role !== "admin")) throw fail_("You can't switch off or demote your own admin login.");
    if (!cur) {
      checkPinRules_(cleanPin_(body.pin), u.role);
      writeUser_({ username: name, name: String(u.name).trim(), role: u.role, active: active, mustChange: "yes", created: new Date().toISOString() }, cleanPin_(body.pin));
    } else {
      var promoted = isManagerRole_(u.role) && !isManagerRole_(cur.role);
      if (promoted) checkPinRules_(cleanPin_(body.pin), u.role);   // managers and admins need a 6+ digit PIN
      writeUser_({ username: name, name: String(u.name).trim(), role: u.role, active: active, mustChange: promoted ? "yes" : undefined }, promoted ? cleanPin_(body.pin) : null);
      if (active === "no" || u.role !== cur.role) endSessions_(name);
    }
    return { ok: true, users: publicUsers_() };
  }
  if (body.cmd === "resetPin") {
    var target = all.filter(function (x) { return x.username === cleanName_(body.username); })[0];
    if (!target) throw fail_("That login no longer exists.");
    checkPinRules_(cleanPin_(body.pin), target.role);
    writeUser_({ username: target.username, mustChange: "yes" }, cleanPin_(body.pin));
    endSessions_(target.username);
    CacheService.getScriptCache().remove("fail_" + target.username);
    return { ok: true, users: publicUsers_() };
  }
  throw fail_("Unknown request.");
}

/** What each role may change. Checked for every operation, before anything is written. */
function permitted_(op, user) {
  var role = user.role;
  if (isManagerRole_(role)) return;
  if (role !== "storeman") throw fail_("Your login can view only.");
  if (op.op === "append") {
    (op.rows || []).forEach(function (r) {
      if (r.type === "reverse") throw fail_("Only a Warehouse Manager or Senior Admin can record corrections.");
      if (/^(countshort|countover|adjust)$/.test(r.type) && (r.from === "WH" || r.to === "WH"))
        throw fail_("Only a Warehouse Manager or Senior Admin can change store stock levels. Submit the count for approval instead.");
    });
    return;
  }
  if (op.op === "create") { if (op.sheet === "Jobs" || op.sheet === "Labels") return; throw fail_("Only a Warehouse Manager or Senior Admin can add vans."); }
  if (op.op === "replaceLines") return;
  if (op.op === "upsert") {
    if (op.sheet === "Jobs") return;
    if (op.sheet === "Counts") return;   // new submissions only: checked in applyBatch_
    if (op.sheet === "Items" && (op.rows || []).every(function (r) { return Object.keys(r).every(function (k) { return k === "sku" || k === "cost"; }); })) return; // receiving updates the average cost
    throw fail_("Only a Warehouse Manager or Senior Admin can change " + (op.sheet === "Items" ? "items." : op.sheet === "VanKit" ? "the van kit." : op.sheet + "."));
  }
  throw fail_("Only a Warehouse Manager or Senior Admin can do that.");
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
  Object.keys(SHEETS).forEach(function (name) { if (name !== "Moves" && !SHEETS[name].private) out[name] = rows_(name, 0); });
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
function applyBatch_(ops, user) {
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
    if (!def || def.private) throw new Error("Unknown tab: " + op.sheet);
    permitted_(op, user);

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
        r.by = user.username;                   // who did it comes from the sign-in, not the phone
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
        if (op.sheet === "Counts") {
          if (!isManagerRole_(user.role) && (cur || r.status !== "pending")) throw fail_("Only a Warehouse Manager or Senior Admin can approve or reject counts.");
          if (!cur) { r.by = user.username; r.status = r.status || "pending"; }
          if (cur && r.status && r.status !== cur.status) {
            if (cur.by === user.username) throw fail_("You can't approve or reject your own count. Another manager or the Senior Admin must do it.");
            r.decidedBy = user.username;
          }
        }
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
