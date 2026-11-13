/**
 * Stock Counter - Google Sheet backend.
 *
 * Paste this whole file into Extensions > Apps Script of the Google Sheet,
 * run setup() once, then Deploy > New deployment > Web app. See SETUP.md.
 *
 * What this protects:
 *  - Everyone signs in with a username and PIN. PINs are stored hashed, never readable.
 *    PIN hashes are keyed with a secret kept in Script Properties (not in the Sheet), so a
 *    leaked or downloaded copy of the Sheet can't be used to work out PINs.
 *    5 wrong PINs locks that login for 15 minutes; 30 wrong PINs across all logins pauses
 *    new sign-ins for 15 minutes (phones already signed in keep working).
 *    Sign-ins last 30 days per device. Sign-ins and login changes are written to a private Log tab.
 *  - Requests are size-limited, so nobody can flood the Sheet with one huge save.
 *  - Roles are enforced HERE, not just in the app:
 *      Senior Admin (admin)          everything, including logins
 *      Warehouse Manager (manager)   everything except logins: inventory, items, costs, corrections
 *      User (storeman)               daily stock work; shelf counts go for approval
 *      Viewer (viewer)               look only
 *  - Only a Senior Admin or Warehouse Manager can change store stock levels.
 *    A count is approved once, and never by the person who counted.
 *  - Every movement is stamped with the signed-in user, so names can't be faked.
 *  - Movements (Moves tab) can only be ADDED, never changed or deleted.
 *  - Manager override: when a User is signed in, a correction or a count decision is accepted only
 *    with a Warehouse Manager's or Senior Admin's OWN username and PIN, checked here (same wrong-PIN
 *    limits as sign-in). The record shows both people (by = the User, approvedBy = the manager).
 *  - The Sheet hands out job, sticker and van numbers, so two phones never clash.
 *  - Job steps are checked (a job can't be kitted or closed twice).
 *  - Stock in the store, vans and jobs can't go below zero.
 *  - Each save is all-or-nothing, and a retried save is applied only once.
 *  - Text that looks like a spreadsheet formula is stored as plain text.
 */

var VERSION = "1.7";

var SHEETS = {
  Items:    { key: "sku",  cols: ["sku", "name", "uom", "track", "cost", "reorder", "allowancePct"] },
  Jobs:     { key: "no",   cols: ["no", "client", "type", "van", "installer", "quoteRef", "status", "created", "kittedAt", "outAt", "closedAt", "missingValue", "reason"] },
  Lines:    { key: "id",   cols: ["id", "job", "sku", "quoted"] },
  Moves:    { key: "id",   cols: ["id", "ts", "type", "sku", "qty", "from", "to", "job", "van", "installer", "serial", "unitCost", "value", "ref", "reason", "by", "reverses", "approvedBy"] },
  Labels:   { key: "code", cols: ["code", "sku", "note"] },
  Vans:     { key: "id",   cols: ["id", "name"] },
  VanKit:   { key: "sku",  cols: ["sku", "target"] },
  Counts:   { key: "id",   cols: ["id", "place", "ts", "by", "status", "lines", "value", "note", "decidedBy", "decidedAt", "decisionNote"] },
  // Private: never sent to any phone.
  Users:    { key: "username", cols: ["username", "name", "role", "active", "mustChange", "salt", "pinHash", "created", "lastLogin"], private: true },
  Sessions: { key: "tokenHash", cols: ["tokenHash", "username", "created", "expires"], private: true },
  Log:      { key: "ts",   cols: ["ts", "username", "event", "detail"], private: true }
};
var NUMBERING = { Jobs: { prefix: "J-", pad: 4, first: 1001 }, Labels: { prefix: "GS-", pad: 4, first: 1 }, Vans: { prefix: "VAN-", pad: 0, first: 1 } };
// admin = Senior Admin, manager = Warehouse Manager, storeman = User, viewer = Viewer (look only)
var ROLES = ["admin", "manager", "storeman", "viewer"];
function isManagerRole_(r) { return r === "admin" || r === "manager"; }
var SESSION_DAYS = 30, MAX_TRIES = 5, LOCK_MINUTES = 15, MAX_TRIES_ALL = 30;
// Size limits per request: generous for real use (under 100 products, a few vans), tight for abuse.
var MAX_BODY = 1000000, MAX_OPS = 300, MAX_ROWS = 3000, MAX_TEXT = 2000, LOG_KEEP = 1000;

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
  ensureColumns_("Moves");   // a Sheet made by an older version gets any new last column(s)
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
  unlock_("admin");
  log_("admin", "admin reset", "from the script editor");
  Logger.log("Admin reset -> username: admin   PIN: " + pin);
  return pin;
}

/* ---------------- spreadsheet menu ---------------- */

/** Adds a "Stock Counter" menu to the spreadsheet. Runs by itself when the spreadsheet opens. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Stock Counter")
    .addItem("Set admin PIN…", "menuSetAdminPin")
    .addItem("Check admin login", "menuCheckAdmin")
    .addSeparator()
    .addItem("Check exceptions now", "menuCheckExceptions")
    .addItem("Turn on daily exception check (6am)", "menuDailyOn")
    .addItem("Turn off daily exception check", "menuDailyOff")
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
  unlock_("admin");
  log_("admin", "admin PIN set", "from the spreadsheet menu");
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
    "Wrong PIN tries across all logins just now: " + Number(CacheService.getScriptCache().get("fail_all") || 0) + (Number(CacheService.getScriptCache().get("fail_all") || 0) >= MAX_TRIES_ALL ? " (new sign-ins PAUSED; Set admin PIN… clears it)" : ""),
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
    var raw = e && e.postData ? String(e.postData.contents || "") : "";
    if (!raw || raw.length > MAX_BODY) throw new Error("Request too large or empty.");
    var body = JSON.parse(raw);
    if (!body || typeof body !== "object") throw new Error("Bad request.");
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
  if (!Array.isArray(ops) || ops.length > MAX_OPS) throw fail_("Too many changes in one save. Save in smaller parts.");
  ops.forEach(function (op) { if (op && op.rows && (!Array.isArray(op.rows) || op.rows.length > MAX_ROWS)) throw fail_("Too many rows in one save. Import in smaller parts."); });
  if (body.batch && String(body.batch).length > 100) throw fail_("Bad request.");
  var approver = null;
  if (ops.length) {
    var cache = CacheService.getScriptCache();
    var done = body.batch ? cache.get("b_" + body.batch) : null;
    if (done) assigned = JSON.parse(done);   // a retry: already applied (and any manager approval already checked), nothing more to do
    else {
      // Manager override: verify the manager FIRST. Nothing is written unless this passes.
      approver = body.override != null ? verifyOverride_(body.override, user) : null;
      try {
        if (approver) overrideScope_(ops);
        assigned = applyBatch_(ops, user, approver);
      } catch (err) {
        if (approver) log_(user.username, "manager approval failed", approver.username + ": " + String(err && err.message || err));
        throw err;
      }
      if (approver) log_(user.username, "manager approval", approver.username + " approved for " + user.username + ": " + overrideSummary_(ops));
      if (body.batch) cache.put("b_" + body.batch, JSON.stringify(assigned), 21600);
    }
    SpreadsheetApp.flush();
  }
  var data = readAll_(Number(body.have) || 0);
  if (user.role === "admin") data.Users = publicUsers_();
  var res = { ok: true, version: VERSION, assigned: assigned, data: data, user: publicUser_(user) };
  if (approver) res.approver = { username: approver.username, name: approver.name };   // so the phone can say who approved (a name, not a secret)
  return res;
}

/* ---------------- logins ---------------- */

function hash_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var h = ((b + 256) % 256).toString(16); return h.length === 1 ? "0" + h : h; }).join("");
}
/** Secret key for PIN hashes. Lives in Script Properties (Project Settings), never in the Sheet. */
function pepper_() {
  var p = PropertiesService.getScriptProperties(), v = p.getProperty("PIN_PEPPER");
  if (!v) { v = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""); p.setProperty("PIN_PEPPER", v); }
  return v;
}
function pinHash_(salt, pin) {
  var bytes = Utilities.computeHmacSha256Signature(salt + ":" + pin, pepper_());
  return "v2:" + bytes.map(function (b) { var h = ((b + 256) % 256).toString(16); return h.length === 1 ? "0" + h : h; }).join("");
}
/** True if the PIN is right. Understands old (v1) hashes so existing logins keep working. */
function pinMatches_(u, pin) {
  if (!u || !u.pinHash || !u.salt) return false;
  var stored = String(u.pinHash);
  return stored.indexOf("v2:") === 0 ? stored === pinHash_(u.salt, pin) : stored === hash_(u.salt + ":" + pin);
}
function unlock_(username) {
  var c = CacheService.getScriptCache();
  c.remove("fail_" + cleanName_(username)); c.remove("fail_all");
}
/** Private audit trail of sign-ins and login changes. Never sent to phones. Keeps the latest rows only. */
function log_(username, event, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName("Log");
    if (!sh) {
      sh = ss.insertSheet("Log");
      sh.getRange(1, 1, 1, SHEETS.Log.cols.length).setValues([SHEETS.Log.cols]).setFontWeight("bold");
      sh.setFrozenRows(1);
      if (sh.hideSheet) sh.hideSheet();
    }
    appendRows_(sh, [[new Date().toISOString(), safe_(String(username || "").slice(0, 40)), safe_(event), safe_(String(detail || "").slice(0, 200))]], 4);
    var extra = sh.getLastRow() - 1 - LOG_KEEP;
    if (extra > 100) sh.deleteRows(2, extra);
  } catch (e) { /* the log must never block a sign-in */ }
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
  if (pin != null) { var salt = Utilities.getUuid(); row.salt = salt; row.pinHash = pinHash_(salt, pin); }
  write_({ op: "upsert", sheet: "Users", rows: [row] });
}
function endSessions_(username) {
  var k = cleanName_(username);
  var keep = rows_("Sessions", 0).filter(function (s) { return s.username === k; }).map(function (s) { return { tokenHash: s.tokenHash }; });
  if (keep.length) write_({ op: "remove", sheet: "Sessions", rows: keep });
}
function endSession_(token) { if (token) write_({ op: "remove", sheet: "Sessions", rows: [{ tokenHash: hash_(String(token)) }] }); }

/**
 * The one place a username + PIN is checked, for sign-in AND for a manager override:
 * per-username wrong-PIN counter and lock, system-wide counter, active login, pinMatches_.
 * mode "login" or "override" only changes the wording and what the Log says. Returns the user, or throws.
 */
function verifyPin_(name, pin, mode, phoneUser) {
  var cache = CacheService.getScriptCache(), fk = "fail_" + name, ov = mode === "override";
  function note(login, detail) { if (ov) log_(phoneUser, "manager approval failed", name + ": " + detail); else log_(name, login, detail); }
  var all = Number(cache.get("fail_all") || 0);
  if (all >= MAX_TRIES_ALL) {
    note("sign-in blocked", "too many wrong PINs on all logins");
    throw fail_(ov ? "Too many wrong PINs on this system just now. Manager approval is paused for " + LOCK_MINUTES + " minutes."
      : "Too many wrong sign-ins on this system just now. New sign-ins are paused for " + LOCK_MINUTES + " minutes. Phones already signed in keep working.");
  }
  var tries = Number(cache.get(fk) || 0);
  if (tries >= MAX_TRIES) {
    note("sign-in blocked", "login locked");
    throw fail_(ov ? "Too many wrong PINs for that manager login. It is locked for " + LOCK_MINUTES + " minutes, or an admin can reset the PIN."
      : "Too many wrong PINs. This login is locked for " + LOCK_MINUTES + " minutes, or an admin can reset the PIN.");
  }
  var u = findUser_(name);
  var ok = u && u.active === "yes" && pinMatches_(u, pin);
  if (!ok) {
    cache.put(fk, String(tries + 1), LOCK_MINUTES * 60);
    cache.put("fail_all", String(all + 1), LOCK_MINUTES * 60);
    note("sign-in failed", !u ? "no such login" : u.active !== "yes" ? "login switched off" : "wrong PIN (" + (tries + 1) + ")");
    var left = MAX_TRIES - tries - 1, hint = left > 0 && left <= 2 ? " " + left + " tries left." : "";
    if (ov) throw fail_("Manager username or PIN is wrong." + hint);
    throw fail_(u && u.active !== "yes" ? "This login has been switched off. Ask an admin." : "Wrong username or PIN." + hint);
  }
  cache.remove(fk);
  return u;
}

function login_(body) {
  var name = cleanName_(body.username).slice(0, 40), pin = cleanPin_(body.pin).slice(0, 20);
  var u = verifyPin_(name, pin, "login");
  if (String(u.pinHash).indexOf("v2:") !== 0) writeUser_({ username: u.username }, pin);   // upgrade an old-style hash
  log_(u.username, "signed in", "");
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
  if (!pinMatches_(user, oldPin)) { log_(user.username, "PIN change failed", "wrong current PIN"); throw fail_("Your current PIN is wrong."); }
  checkPinRules_(newPin, user.role);
  if (newPin === oldPin) throw fail_("Choose a different PIN from the current one.");
  writeUser_({ username: user.username, mustChange: "no" }, newPin);
  log_(user.username, "PIN changed", "");
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
    log_(me.username, cur ? "login changed" : "login created", name + " · " + u.role + (active === "no" ? " · switched off" : ""));
    return { ok: true, users: publicUsers_() };
  }
  if (body.cmd === "resetPin") {
    var target = all.filter(function (x) { return x.username === cleanName_(body.username); })[0];
    if (!target) throw fail_("That login no longer exists.");
    checkPinRules_(cleanPin_(body.pin), target.role);
    writeUser_({ username: target.username, mustChange: "yes" }, cleanPin_(body.pin));
    endSessions_(target.username);
    CacheService.getScriptCache().remove("fail_" + target.username);
    log_(me.username, "PIN reset", target.username);
    return { ok: true, users: publicUsers_() };
  }
  throw fail_("Unknown request.");
}

/* ---------------- manager override ----------------
 * A User's phone may carry { override: { username, pin } } on a sync request. The Sheet checks it
 * (never the phone), and only for corrections and count decisions. The PIN is used here once:
 * it is never logged, stored, cached or sent back.
 */
var OVERRIDE_SCOPE_MSG = "Manager approval is only for corrections and count decisions.";
var OVERRIDE_WHO_MSG = "Manager approval must come from a Warehouse Manager or Senior Admin other than you.";
// Same list as REVERSIBLE in the app: the movement types a correction may undo.
var REVERSIBLE_ = { receive: 1, topup: 1, extra: 1, "return": 1, scrap: 1, countshort: 1, countover: 1, adjust: 1, out: 1 };
var COUNT_MOVE_ = { countshort: 1, countover: 1, kituse: 1 };
var COUNT_DECISION_KEYS_ = { id: 1, status: 1, decidedAt: 1, decisionNote: 1 };

/** Checks the manager's own username and PIN like a sign-in (same counters and lock). Returns the approver. */
function verifyOverride_(o, user) {
  o = o && typeof o === "object" && !Array.isArray(o) ? o : {};
  var name = cleanName_(o.username).slice(0, 40), pin = cleanPin_(o.pin).slice(0, 20);
  var a = verifyPin_(name, pin, "override", user.username);
  if (!isManagerRole_(a.role) || a.username === user.username) {
    log_(user.username, "manager approval failed", name + ": not a manager other than the signed-in user");
    throw fail_(OVERRIDE_WHO_MSG);
  }
  if (a.mustChange === "yes") { log_(user.username, "manager approval failed", name + ": still on a temporary PIN"); throw fail_("That manager must sign in once and choose their own PIN first."); }
  if (user.role === "viewer") { log_(user.username, "manager approval failed", "viewer login"); throw fail_("Your login can view only."); }
  return a;
}

/** What an override batch may contain, judged from the request alone: reversals and count decisions (with their adjustment moves). */
function overrideScope_(ops) {
  var decided = {}, any = false;
  ops.forEach(function (op) {
    if (op && op.op === "upsert" && op.sheet === "Counts") {
      if (!Array.isArray(op.rows) || !op.rows.length) throw fail_(OVERRIDE_SCOPE_MSG);
      op.rows.forEach(function (r) {
        var id = r && String(r.id || "");
        if (!id || decided[id] || (r.status !== "approved" && r.status !== "rejected")) throw fail_(OVERRIDE_SCOPE_MSG);
        Object.keys(r).forEach(function (k) { if (!COUNT_DECISION_KEYS_[k]) throw fail_(OVERRIDE_SCOPE_MSG); });
        decided[id] = r.status; any = true;
      });
    }
  });
  ops.forEach(function (op) {
    if (op && op.op === "upsert" && op.sheet === "Counts") return;
    if (!op || op.op !== "append" || op.sheet !== "Moves" || !Array.isArray(op.rows) || !op.rows.length) throw fail_(OVERRIDE_SCOPE_MSG);
    op.rows.forEach(function (r) {
      if (!r || typeof r !== "object") throw fail_(OVERRIDE_SCOPE_MSG);
      if (r.type === "reverse") { any = true; return; }
      if (COUNT_MOVE_[r.type] && decided[String(r.ref || "")] === "approved") return;   // booked by an approval in this same batch
      throw fail_(OVERRIDE_SCOPE_MSG);
    });
  });
  if (!any) throw fail_(OVERRIDE_SCOPE_MSG);
}

/** Text for the Log: how many corrections, which counts. */
function overrideSummary_(ops) {
  var corr = 0, counts = [];
  ops.forEach(function (op) {
    if (op.op === "append") (op.rows || []).forEach(function (r) { if (r.type === "reverse") corr++; });
    else if (op.op === "upsert" && op.sheet === "Counts") (op.rows || []).forEach(function (r) { counts.push("count " + r.id + " " + r.status); });
  });
  return (corr ? corr + " correction(s)" : "") + (corr && counts.length ? "; " : "") + counts.join("; ");
}

/** A correction must undo exactly one real, reversible movement that isn't already undone (the phone can't invent one). */
function checkReversal_(r, moves) {
  var orig = moves[String(r.ref || "")];
  if (!orig || !REVERSIBLE_[orig.type] || r.reverses !== orig.type || String(r.sku) !== String(orig.sku) ||
      Math.abs(Number(r.qty) - Number(orig.qty)) > 0.005 || r.from !== orig.to || r.to !== orig.from) throw fail_(OVERRIDE_SCOPE_MSG);
  Object.keys(moves).forEach(function (k) {
    if (k !== String(r.id) && moves[k].type === "reverse" && String(moves[k].ref) === String(orig.id)) throw fail_("That movement has already been corrected. Refresh.");
  });
}

/** The adjustment moves an approval must book for a count, exactly as the app works them out from the count's lines. */
function expectedCountMoves_(c) {
  var lines; try { lines = JSON.parse(c.lines || "[]"); } catch (e) { lines = []; }
  var isVan = c.place !== "WH", out = {};
  (Array.isArray(lines) ? lines : []).forEach(function (l) {
    var diff = Math.round(Number(l && l.diff) * 100) / 100;
    if (!l || !isFinite(diff) || Math.abs(diff) <= 1e-9) return;
    out[String(l.sku)] = diff < 0
      ? { type: isVan ? "kituse" : "countshort", qty: -diff, from: c.place, to: isVan ? "USED" : "LOSS" }
      : { type: "countover", qty: diff, from: "LOSS", to: c.place };
  });
  return out;
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


/* ---------------- exception rules ----------------
 * Fixed rules, no AI. Reads the app's tabs, writes the "Exceptions" tab (rewritten each run).
 * The Exceptions tab is never sent to phones. Change the thresholds below to suit the business.
 */
var RULES = {
  JOB_OUT_DAYS: 7,          // job on site this long and still not closed (stock out there, unexplained)
  JOB_KITTED_DAYS: 3,       // crate packed this long and not collected
  OVER_QUOTE_PCT: 10,       // issued (open job) or consumed (closed job) above quote by more than this
  COUNT_PENDING_DAYS: 2,    // a submitted shelf count waiting this long for approval
  LOOKBACK_DAYS: 7,         // window for "recent" rules (missing, van shortfalls, corrections)
  VAN_SHORT_VALUE: 500,     // R: van kit shortfall per van in the window worth a look
  REPEAT_JOBS: 2,           // same installer with missing stock on this many jobs...
  REPEAT_WINDOW_DAYS: 30    // ...within this many days
};
var EXC_COLS = ["checked", "severity", "rule", "ref", "detail", "value", "who"];

function menuCheckExceptions() {
  var r = checkExceptions();
  SpreadsheetApp.getActiveSpreadsheet().toast(r.high + " high, " + r.medium + " medium, " + r.low + " low. See the Exceptions tab.", "Exceptions checked", 8);
}
function menuDailyOn() {
  menuDailyOff_(true);
  ScriptApp.newTrigger("checkExceptions").timeBased().everyDays(1).atHour(6).create();
  SpreadsheetApp.getUi().alert("Daily check is on. It runs every morning around 6am and rewrites the Exceptions tab.");
}
function menuDailyOff() { menuDailyOff_(false); }
function menuDailyOff_(quiet) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "checkExceptions") ScriptApp.deleteTrigger(t); });
  if (!quiet) SpreadsheetApp.getUi().alert("Daily check is off.");
}

/** Runs every rule and rewrites the Exceptions tab. Returns counts by severity. */
function checkExceptions(nowMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var d;
  try { d = {}; ["Items", "Jobs", "Lines", "Moves", "Counts", "Vans"].forEach(function (n) { d[n] = rows_(n, 0); }); }
  finally { lock.releaseLock(); }
  var out = exceptions_(d, nowMs || Date.now());
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName("Exceptions") || ss.insertSheet("Exceptions");
  var stamp = new Date(nowMs || Date.now()).toISOString();
  var rows = out.length ? out.map(function (e) { return EXC_COLS.map(function (c) { return c === "checked" ? stamp : safe_(e[c] == null ? "" : e[c]); }); })
    : [[stamp, "OK", "All clear", "", "No exceptions found.", "", ""]];
  var old = sh.getLastRow();
  if (old > 0) sh.getRange(1, 1, old, EXC_COLS.length).clearContent();
  sh.getRange(1, 1, 1, EXC_COLS.length).setValues([EXC_COLS]).setFontWeight("bold");
  sh.setFrozenRows(1);
  ensureRows_(sh, rows.length + 1, EXC_COLS.length);
  sh.getRange(2, 1, rows.length, EXC_COLS.length).setValues(rows);
  var c = { high: 0, medium: 0, low: 0 };
  out.forEach(function (e) { c[e.severity.toLowerCase()]++; });
  return c;
}

/** Pure rule engine: data in, list of exceptions out (sorted High first, then by value). */
function exceptions_(d, now) {
  var R2 = function (n) { return Math.round(Number(n || 0) * 100) / 100; };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
  var days = function (ts) { var t = new Date(ts).getTime(); return isFinite(t) ? (now - t) / 864e5 : 0; };
  var items = {}; d.Items.forEach(function (i) { items[i.sku] = i; });
  var cost = function (sku) { return num(items[sku] && items[sku].cost); };
  var name = function (sku) { return (items[sku] && items[sku].name) || sku; };
  var out = [];
  function add(sev, rule, ref, detail, value, who) { out.push({ severity: sev, rule: rule, ref: ref, detail: detail, value: value == null ? "" : R2(value), who: who || "" }); }

  // balances per place
  var B = {};
  d.Moves.forEach(function (m) {
    var q = num(m.qty);
    if (m.from) { B[m.from] = B[m.from] || {}; B[m.from][m.sku] = (B[m.from][m.sku] || 0) - q; }
    if (m.to) { B[m.to] = B[m.to] || {}; B[m.to][m.sku] = (B[m.to][m.sku] || 0) + q; }
  });
  var bal = function (loc, sku) { return R2((B[loc] && B[loc][sku]) || 0); };

  // 1. Integrity: no real place may be negative.
  Object.keys(B).forEach(function (loc) {
    if (!isRealPlace_(loc)) return;
    Object.keys(B[loc]).forEach(function (sku) { if (bal(loc, sku) < -0.004) add("High", "Negative stock", loc, name(sku) + ": " + bal(loc, sku) + ". Should never happen; check recent corrections.", bal(loc, sku) * cost(sku)); });
  });

  // per-job issued vs quoted (same logic as the app's job summary)
  function job_(no) {
    var loc = "JOB:" + no, r = {};
    var row = function (sku) { return r[sku] || (r[sku] = { quoted: 0, issued: 0, back: 0 }); };
    d.Lines.forEach(function (l) { if (l.job === no) row(l.sku).quoted += num(l.quoted); });
    d.Moves.forEach(function (m) {
      var q = num(m.qty);
      if (m.type === "reverse") { if ((m.reverses === "extra" || m.reverses === "out") && m.from === loc) row(m.sku).issued -= q; return; }
      if (m.to === loc) row(m.sku).issued += q;
      else if (m.from === loc && (m.to === "WH" || m.to === "SCRAP")) row(m.sku).back += q;
    });
    return r;
  }
  function stockAt(no) { var loc = "JOB:" + no, v = 0; Object.keys(B[loc] || {}).forEach(function (sku) { if (bal(loc, sku) > 0) v += bal(loc, sku) * cost(sku); }); return R2(v); }

  d.Jobs.forEach(function (j) {
    var who = j.installer || "";
    // 2. Jobs left open: the leak this app exists to stop. Stock on site never becomes "missing" until the job is closed.
    if (j.status === "out" && days(j.outAt) >= RULES.JOB_OUT_DAYS)
      add(stockAt(j.no) > 0 ? "High" : "Medium", "Job on site, not closed", j.no, (j.client || "") + " · on site " + Math.floor(days(j.outAt)) + " days. Close it: return leftovers, record what was used.", stockAt(j.no), who);
    if (j.status === "kitted" && days(j.kittedAt) >= RULES.JOB_KITTED_DAYS)
      add("Medium", "Crate packed, not collected", j.no, (j.client || "") + " · packed " + Math.floor(days(j.kittedAt)) + " days ago. Collect it or unpack it.", stockAt(j.no), who);
    // 3. Over quote: open jobs on what was issued; recently closed jobs on what was consumed.
    var open = j.status === "out" || j.status === "kitted";
    var recentClosed = j.status === "closed" && days(j.closedAt) <= RULES.LOOKBACK_DAYS;
    if (open || recentClosed) {
      var r = job_(j.no);
      Object.keys(r).forEach(function (sku) {
        var x = r[sku], used = open ? x.issued : x.issued - x.back;
        if (used <= 0.004) return;
        if (x.quoted <= 0.004) { add("Medium", "Issued, not on quote", j.no, name(sku) + ": " + R2(used) + " " + (items[sku] ? items[sku].uom : "") + " with no quote line.", used * cost(sku), who); return; }
        // Open jobs are kitted with the cable allowance on purpose, so measure them against the kit, not the bare quote.
        var it = items[sku] || {}, isLen = it.uom === "m" || it.uom === "in";
        var allow = open && isLen ? (it.allowancePct === "" || it.allowancePct == null ? 10 : num(it.allowancePct)) : 0;
        var base = allow ? Math.ceil(R2(x.quoted * (1 + allow / 100)) - 1e-9) : x.quoted;
        var limit = base + x.quoted * RULES.OVER_QUOTE_PCT / 100;
        if (used > limit + 0.004)
          add("Medium", open ? "Issued over quote" : "Used over quote", j.no, name(sku) + ": " + R2(used) + " vs quote " + R2(x.quoted) + (allow ? " (kit " + base + ")" : "") + ", +" + Math.round((used / x.quoted - 1) * 100) + "%.", (used - x.quoted) * cost(sku), who);
      });
    }
  });

  // 4. Missing stock in the window, and repeat patterns per installer.
  var perInstaller = {};
  d.Moves.forEach(function (m) {
    if (m.to !== "LOSS" || m.type === "reverse") return;
    var age = days(m.ts);
    if (m.installer && m.job && age <= RULES.REPEAT_WINDOW_DAYS) { (perInstaller[m.installer] = perInstaller[m.installer] || {})[m.job] = true; }
    if (age > RULES.LOOKBACK_DAYS) return;
    add("High", m.job ? "Missing after job" : "Count shortage", m.job || m.from, name(m.sku) + ": " + R2(num(m.qty)) + " not returned or not found." + (m.reason ? " Reason: " + m.reason : ""), num(m.value), m.installer || m.by);
  });
  Object.keys(perInstaller).forEach(function (who) {
    var jobs = Object.keys(perInstaller[who]);
    if (jobs.length >= RULES.REPEAT_JOBS) add("High", "Repeat missing stock", who, "Missing stock on " + jobs.length + " jobs in " + RULES.REPEAT_WINDOW_DAYS + " days: " + jobs.join(", ") + ". A pattern, not bad luck.", null, who);
  });

  // 5. Van kit shortfalls are booked as "used", so they never show as missing. Flag large ones.
  var vanShort = {};
  d.Moves.forEach(function (m) { if (m.type === "kituse" && days(m.ts) <= RULES.LOOKBACK_DAYS) vanShort[m.from] = (vanShort[m.from] || 0) + num(m.value); });
  var vanName = {}; d.Vans.forEach(function (v) { vanName[v.id] = v.name; });
  Object.keys(vanShort).forEach(function (v) {
    if (vanShort[v] >= RULES.VAN_SHORT_VALUE) add("Medium", "Van kit shortfall", vanName[v] || v, "Van counts found this much less than the system in " + RULES.LOOKBACK_DAYS + " days. Booked as used on jobs; check it matches the work done.", vanShort[v]);
  });

  // 6. Low stock in the store.
  d.Items.forEach(function (i) {
    var lvl = num(i.reorder), wh = bal("WH", i.sku);
    if (lvl > 0 && wh < lvl) add("Medium", "Low stock", i.sku, name(i.sku) + ": " + wh + " in store, order level " + lvl + ".", (lvl - wh) * cost(i.sku));
  });

  // 7. Counts waiting for approval.
  d.Counts.forEach(function (c) {
    if (c.status === "pending" && days(c.ts) >= RULES.COUNT_PENDING_DAYS) add("Medium", "Count waiting for approval", c.id, "Submitted " + Math.floor(days(c.ts)) + " days ago by " + (c.by || "?") + ". Stock is not updated until approved.", num(c.value), c.by);
  });

  // 8. Corrections in the window: every one should have a good reason.
  d.Moves.forEach(function (m) {
    if (m.type === "reverse" && days(m.ts) <= RULES.LOOKBACK_DAYS) add("Low", "Correction made", m.job || m.sku, name(m.sku) + ": undid " + (m.reverses || "") + " of " + R2(num(m.qty)) + ". Reason: " + (m.reason || "none") + (m.approvedBy ? " (approved by " + m.approvedBy + ")" : ""), num(m.value), m.by);
  });

  var rank = { High: 0, Medium: 1, Low: 2 };
  out.sort(function (a, b) { return rank[a.severity] - rank[b.severity] || Math.abs(num(b.value)) - Math.abs(num(a.value)); });
  return out;
}

/* ---------------- writing ---------------- */

/**
 * Two phases. Phase 1 checks every operation against an in-memory copy and works out
 * new numbers. Nothing is written unless every check passes. Phase 2 writes.
 */
function applyBatch_(ops, user, approver) {
  var actor = approver || user;   // with a manager override, permission checks run as the manager
  var mem = {};          // sheet -> { keys: [...], rows: {key: row} } loaded on demand
  function load(name) {
    if (mem[name]) return mem[name];
    var rows = rows_(name, 0), byKey = {}, k = SHEETS[name].key;
    rows.forEach(function (r) { byKey[String(r[k])] = r; });
    mem[name] = { keys: rows.map(function (r) { return String(r[k]); }), rows: byKey };
    return mem[name];
  }
  var assigned = {}, plan = [], newMoves = [], countSeen = {}, decidedCounts = {};
  // counts as they were BEFORE this batch (an override judges moves against the count's state when it was pending)
  var counts0 = approver ? JSON.parse(JSON.stringify(load("Counts").rows)) : null;

  ops.forEach(function (raw) {
    var op = substitute_(raw, assigned);
    var def = SHEETS[op.sheet];
    if (!def || def.private) throw new Error("Unknown tab: " + op.sheet);
    permitted_(op, actor);

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
        r.approvedBy = approver ? approver.username : "";   // likewise: only the Sheet says who approved
        return true;
      });
      if (approver) fresh.forEach(function (r) {
        if (r.type === "reverse") return checkReversal_(r, seen);
        // a count adjustment: must be one the approved count calls for, once
        var c = counts0[String(r.ref)], want = c && c.status === "pending" ? expectedCountMoves_(c)[String(r.sku)] : null;
        if (c && c.status !== "pending") throw fail_("This count has already been decided. Refresh.");
        var cs = countSeen[c && c.id] = countSeen[c && c.id] || {};
        if (!want || cs[r.sku] || want.type !== r.type || want.from !== r.from || want.to !== r.to || Math.abs(Number(r.qty) - want.qty) > 0.005) throw fail_(OVERRIDE_SCOPE_MSG);
        cs[r.sku] = true;
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
          if (!isManagerRole_(actor.role) && (cur || r.status !== "pending")) throw fail_("Only a Warehouse Manager or Senior Admin can approve or reject counts.");
          if (approver) {
            if (!cur) throw fail_(OVERRIDE_SCOPE_MSG);
            if (cur.status !== "pending") throw fail_("This count has already been decided. Refresh.");
          }
          if (!cur) { r.by = user.username; r.status = r.status || "pending"; }
          if (cur && r.status && r.status !== cur.status) {
            if (cur.by === actor.username) throw fail_("You can't approve or reject your own count. Another manager or the Senior Admin must do it.");
            r.decidedBy = actor.username;   // with an override this is the manager, not the phone's user
            if (approver && r.status === "approved") decidedCounts[k] = true;
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

  // An approval must book every adjustment the count calls for: a phone can't approve and quietly leave some out.
  Object.keys(decidedCounts).forEach(function (id) {
    Object.keys(expectedCountMoves_(counts0[id])).forEach(function (sku) {
      if (!(countSeen[id] && countSeen[id][sku])) throw fail_(OVERRIDE_SCOPE_MSG);
    });
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
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT);
  return /^[=+@\t\r]/.test(s) || /^-[^0-9.]/.test(s) ? "'" + s : s;
}
function toRow_(cols, obj) { return cols.map(function (c) { return safe_(obj[c]); }); }

/**
 * A Sheet tab only has so many rows (1,000 by default) and writing below the last one fails.
 * Make room first, in blocks of 500, keeping new rows as plain text like the rest.
 */
function ensureRows_(sh, lastRowNeeded, cols) {
  var max = sh.getMaxRows();
  if (lastRowNeeded <= max) return;
  var add = Math.max(500, lastRowNeeded - max);
  sh.insertRowsAfter(max, add);
  sh.getRange(max + 1, 1, add, cols || sh.getMaxColumns()).setNumberFormat("@");
}
/**
 * Adds any column the code knows about that an older Sheet doesn't have yet, at the END of the header row
 * (so no existing data moves). Safe to run again. If an earlier header was changed by hand it does nothing.
 */
function ensureColumns_(name) {
  var sh = sheet_(name), cols = SHEETS[name].cols;
  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  var head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  for (var i = 0; i < cols.length; i++) {
    if (String(head[i]) === cols[i]) continue;
    if (String(head[i]) !== "") return;
    sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat("@");
    sh.getRange(1, i + 1, 1, 1).setValues([[cols[i]]]).setFontWeight("bold");
  }
}
/** Append rows below the last used row, making room if needed. */
function appendRows_(sh, values, cols) {
  if (!values.length) return;
  var start = sh.getLastRow() + 1;
  ensureRows_(sh, start + values.length - 1, cols);
  sh.getRange(start, 1, values.length, cols).setValues(values);
}

function write_(step) {
  var def = SHEETS[step.sheet], sh = sheet_(step.sheet), cols = def.cols, rows = step.rows || [];

  if (step.op === "insert") {
    if (step.sheet === "Moves") ensureColumns_("Moves");   // an older Sheet may not have the newest column yet
    appendRows_(sh, rows.map(function (r) { return toRow_(cols, r); }), cols.length);
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
        appendRows_(sh, [toRow_(cols, r)], cols.length);
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
    appendRows_(sh, rows.map(function (r) { return toRow_(cols, r); }), cols.length);
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
