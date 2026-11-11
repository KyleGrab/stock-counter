/*
 * Stock Counter - the phone app.
 * Flow: Quote -> Kit -> Van collects -> Return check -> Closed.
 * Data lives in a Google Sheet (live mode) or only on this phone (demo mode).
 */
"use strict";
var C = window.Core;

/* ===================== settings & storage ===================== */
var LS = {
  get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
var cfg = Object.assign({ mode: null, url: "", token: "", user: null, site: "" }, LS.get("sc_cfg", {}));
delete cfg.key; delete cfg.name;   // replaced by logins in v1.2
function saveCfg() { LS.set("sc_cfg", cfg); }
function siteUrl() { return (cfg.site || (location.origin + location.pathname)).replace(/\?.*$/, ""); }

/* ===================== data ===================== */
/*
 * SD = what the Sheet has confirmed (kept on the phone so the app works without signal).
 * Q  = saves waiting to reach the Sheet (offline queue). Each has a fixed batch id, so a retry is applied once.
 * D  = what the screens show: SD plus the queued saves applied on top.
 */
var APP_VERSION = "1.7";
var TABS = ["Items", "Jobs", "Lines", "Moves", "Labels", "Vans", "VanKit", "Counts"];
function emptyData() { var d = {}; TABS.forEach(function (t) { d[t] = []; }); return d; }
var SD = LS.get("sc_sd", null) || emptyData();
var Q = LS.get("sc_queue", []) || [];
var D = emptyData();
var X = { items: {}, jobs: {}, labels: {}, vans: [], kit: [], B: {} }; // derived

function derive() {
  X.items = {}; D.Items.forEach(function (i) { X.items[i.sku] = i; });
  X.jobs = {}; D.Jobs.forEach(function (j) { X.jobs[j.no] = j; });
  X.labels = {}; D.Labels.forEach(function (l) { X.labels[l.code] = l; });
  X.vans = D.Vans.slice().sort(function (a, b) { return a.id.localeCompare(b.id); });
  X.kit = D.VanKit.filter(function (k) { return Number(k.target) > 0; });
  D.Moves.sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  X.B = C.balances(D.Moves);
}
function rebuild() {
  D = JSON.parse(JSON.stringify(SD));
  TABS.forEach(function (t) { D[t] = D[t] || []; });
  Q.forEach(function (b) { applyOpsLocal(D, b.ops); });
  derive();
}
function persist() { LS.set("sc_sd", SD); LS.set("sc_queue", Q); }

var KEYS = { Items: "sku", Jobs: "no", Lines: "id", Moves: "id", Labels: "code", Vans: "id", VanKit: "sku", Counts: "id" };
// Apply changes to a local copy (queued saves on screen, and the demo "sheet").
function applyOpsLocal(d, ops) {
  ops.forEach(function (op) {
    var rows = op.rows || [];
    d[op.sheet] = d[op.sheet] || [];
    var list = d[op.sheet];
    if (op.op === "append") {
      var have = {}; list.forEach(function (r) { have[r.id] = 1; });
      rows.forEach(function (r) { if (!have[r.id]) { list.push(r); have[r.id] = 1; } });
    } else if (op.op === "upsert") {
      var k = KEYS[op.sheet];
      rows.forEach(function (r) {
        var at = list.findIndex(function (x) { return String(x[k]) === String(r[k]); });
        if (at >= 0) list[at] = Object.assign({}, list[at], r); else list.push(Object.assign({}, r));
      });
    } else if (op.op === "replaceLines") {
      d.Lines = list.filter(function (l) { return l.job !== op.job; }).concat(rows);
    } else if (op.op === "remove") {
      var k2 = KEYS[op.sheet], del = {};
      rows.forEach(function (r) { del[r[k2]] = 1; });
      d[op.sheet] = list.filter(function (x) { return !del[x[k2]]; });
    }
  });
}

/* ===================== backends ===================== */
var NUMBERING = { Jobs: ["J-", 4, 1001], Labels: ["GS-", 4, 1], Vans: ["VAN-", 0, 1] };

// The same role rules the Sheet enforces (Code.gs permitted_). Used by the demo, and to hide buttons.
function permitted(op, role) {
  if (role === "admin" || role === "manager") return null;
  if (role !== "storeman") return "Your login can view only.";
  if (op.op === "append") {
    var rows = op.rows || [];
    if (rows.some(function (r) { return r.type === "reverse"; })) return "Only an admin can record corrections.";
    if (rows.some(function (r) { return /^(countshort|countover|adjust)$/.test(r.type) && (r.from === "WH" || r.to === "WH"); })) return "Only a Warehouse Manager or Senior Admin can change store stock levels. Submit the count for approval instead.";
    return null;
  }
  if (op.op === "create") return op.sheet === "Jobs" || op.sheet === "Labels" ? null : "Only an admin can add vans.";
  if (op.op === "replaceLines") return null;
  if (op.op === "upsert") {
    if (op.sheet === "Jobs" || op.sheet === "Counts") return null;
    if (op.sheet === "Items" && (op.rows || []).every(function (r) { return Object.keys(r).every(function (k) { return k === "sku" || k === "cost"; }); })) return null;
    return "Only an admin can change " + (op.sheet === "Items" ? "items." : op.sheet === "VanKit" ? "the van kit." : op.sheet + ".");
  }
  return "Only an admin can do that.";
}
function pinProblem(pin, role) {
  var min = role === "admin" || role === "manager" ? 6 : 4;
  pin = String(pin || "");
  if (!/^\d+$/.test(pin) || pin.length < min || pin.length > 8) return "PIN must be " + min + " to 8 digits" + (min === 6 ? " for managers and admins." : ".");
  if (/^(\d)\1+$/.test(pin) || "0123456789".indexOf(pin) >= 0 || "9876543210".indexOf(pin) >= 0) return "Choose a PIN that isn't all the same digit or a simple run like 1234.";
  return null;
}
function suggestPin(len) {
  var p = "";
  do { p = ""; var a = new Uint32Array(len); crypto.getRandomValues(a); for (var i = 0; i < len; i++) p += String(a[i] % 10); } while (pinProblem(p, len >= 6 ? "admin" : "storeman"));
  return p;
}

/*
 * Demo mode: a pretend Sheet on this phone that follows the same rules as Code.gs,
 * including logins and roles, so the demo behaves like the real thing.
 */
var DEMO_USERS = [
  { username: "admin", name: "Kyle (senior admin)", role: "admin", active: "yes", mustChange: "no", pin: "246810" },
  { username: "lebo", name: "Lebo (warehouse manager)", role: "manager", active: "yes", mustChange: "no", pin: "580214" },
  { username: "sipho", name: "Sipho (user)", role: "storeman", active: "yes", mustChange: "no", pin: "1357" },
  { username: "owner", name: "Owner (viewer)", role: "viewer", active: "yes", mustChange: "no", pin: "8642" }
];
function demoErr(msg, signIn) { var e = new Error(msg); e.signIn = !!signIn; return e; }
var demo = {
  users: function () {
    var list = LS.get("sc_demo_users", null) || JSON.parse(JSON.stringify(DEMO_USERS));
    // demo data from an older version: add missing demo logins and update their labels
    DEMO_USERS.forEach(function (d) {
      var u = list.find(function (x) { return x.username === d.username; });
      if (!u) list.push(JSON.parse(JSON.stringify(d)));
      else if (u.role === d.role) u.name = d.name;
    });
    return list;
  },
  publicUser: function (u) { return { username: u.username, name: u.name, role: u.role, mustChange: u.mustChange === "yes" }; },
  call: function (action, body) {
    var self = this;
    return new Promise(function (resolve, reject) {
      try {
        var users = self.users(), sessions = LS.get("sc_demo_sessions", {});
        if (action === "login") {
          var u = users.find(function (x) { return x.username === String(body.username || "").trim().toLowerCase(); });
          if (!u || u.pin !== String(body.pin)) throw demoErr("Wrong username or PIN.");
          if (u.active !== "yes") throw demoErr("This login has been switched off. Ask an admin.");
          var t = uid() + uid();
          sessions[t] = u.username; LS.set("sc_demo_sessions", sessions);
          u.lastLogin = now(); LS.set("sc_demo_users", users);
          return resolve({ ok: true, token: t, user: self.publicUser(u) });
        }
        var me = users.find(function (x) { return x.username === sessions[body.token]; });
        if (!me || me.active !== "yes") throw demoErr("Please sign in again.", true);
        if (me.mustChange === "yes" && action !== "changePin" && action !== "logout") throw demoErr("Choose your own PIN first.", true);
        if (action === "logout") { delete sessions[body.token]; LS.set("sc_demo_sessions", sessions); return resolve({ ok: true }); }
        if (action === "changePin") {
          if (me.pin !== String(body.oldPin)) throw demoErr("Your current PIN is wrong.");
          var pp = pinProblem(body.newPin, me.role); if (pp) throw demoErr(pp);
          me.pin = String(body.newPin); me.mustChange = "no"; LS.set("sc_demo_users", users);
          return resolve({ ok: true, user: self.publicUser(me) });
        }
        if (action === "users") return resolve(self.usersCmd(body, me, users, sessions));
        if (action === "sync") return resolve(self.sync(body, me, users));
        throw demoErr("Unknown request.");
      } catch (e) { reject(e); }
    });
  },
  listUsers: function (users) { return users.map(function (u) { return { username: u.username, name: u.name, role: u.role, active: u.active, mustChange: u.mustChange, lastLogin: u.lastLogin || "" }; }); },
  endSessions: function (sessions, username) { Object.keys(sessions).forEach(function (t) { if (sessions[t] === username) delete sessions[t]; }); LS.set("sc_demo_sessions", sessions); },
  usersCmd: function (body, me, users, sessions) {
    if (me.role !== "admin") throw demoErr("Only a Senior Admin can manage logins.");
    if (body.cmd === "save") {
      var u = body.user || {}, name = String(u.username || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,30}$/.test(name)) throw demoErr("Username: 2 to 30 letters, numbers, dots or dashes. No spaces.");
      if (["admin", "manager", "storeman", "viewer"].indexOf(u.role) < 0) throw demoErr("Choose a role.");
      if (!String(u.name || "").trim()) throw demoErr("Add the person's name.");
      var cur = users.find(function (x) { return x.username === name; });
      if (cur && body.isNew) throw demoErr("That username is taken. Choose another.");
      var active = u.active === "no" ? "no" : "yes";
      var after = users.filter(function (x) { return x.username !== name; }).concat([{ role: u.role, active: active }]);
      if (!after.some(function (x) { return x.role === "admin" && x.active === "yes"; })) throw demoErr("There must always be at least one active admin.");
      if (name === me.username && (active === "no" || u.role !== "admin")) throw demoErr("You can't switch off or demote your own admin login.");
      if (!cur) {
        var p1 = pinProblem(body.pin, u.role); if (p1) throw demoErr(p1);
        users.push({ username: name, name: u.name.trim(), role: u.role, active: active, mustChange: "yes", pin: String(body.pin), created: now() });
      } else {
        var promoted = (u.role === "admin" || u.role === "manager") && !(cur.role === "admin" || cur.role === "manager");
        if (promoted) { var p2 = pinProblem(body.pin, u.role); if (p2) throw demoErr(p2); cur.pin = String(body.pin); cur.mustChange = "yes"; }
        if (active === "no" || u.role !== cur.role) this.endSessions(sessions, name);
        cur.name = u.name.trim(); cur.role = u.role; cur.active = active;
      }
      LS.set("sc_demo_users", users);
      return { ok: true, users: this.listUsers(users) };
    }
    if (body.cmd === "resetPin") {
      var t = users.find(function (x) { return x.username === body.username; });
      if (!t) throw demoErr("That login no longer exists.");
      var p3 = pinProblem(body.pin, t.role); if (p3) throw demoErr(p3);
      t.pin = String(body.pin); t.mustChange = "yes"; this.endSessions(sessions, t.username);
      LS.set("sc_demo_users", users);
      return { ok: true, users: this.listUsers(users) };
    }
    throw demoErr("Unknown request.");
  },
  sync: function (body, me, users) {
    var d = LS.get("sc_demo", null) || seedDemo();
    var done = LS.get("sc_demo_batches", {}) || {};
    var assigned = {};
    if (body.ops && body.ops.length) {
      if (done[body.batch]) assigned = done[body.batch];
      else {
        var work = JSON.parse(JSON.stringify(d)), newMoves = [];
        body.ops.forEach(function (raw) {
          var op = JSON.parse(JSON.stringify(raw), function (k, v) {
            if (typeof v !== "string" || k === "ref") return v;
            Object.keys(assigned).forEach(function (r) { v = v.replace(new RegExp(r.replace(/[$]/g, "\\$&") + "(?![A-Za-z0-9_])", "g"), assigned[r]); });
            return v;
          });
          var why = permitted(op, me.role); if (why) throw demoErr(why);
          if (op.op === "create") {
            var nb = NUMBERING[op.sheet], key = KEYS[op.sheet];
            var id = C.nextNumber(work[op.sheet].map(function (r) { return r[key]; }), nb[0], nb[1]);
            if (parseInt(id.slice(nb[0].length), 10) < nb[2]) { id = String(nb[2]); while (id.length < nb[1]) id = "0" + id; id = nb[0] + id; }
            var row = Object.assign({}, op.row); row[key] = id; work[op.sheet].push(row);
            if (op.ref) assigned[op.ref] = id;
            return;
          }
          if (op.op === "upsert" && op.sheet === "Counts") {
            op.rows.forEach(function (r) {
              var cur = work.Counts.find(function (x) { return x.id === r.id; });
              var mgr = me.role === "admin" || me.role === "manager";
              if (!mgr && (cur || r.status !== "pending")) throw demoErr("Only a Warehouse Manager or Senior Admin can approve or reject counts.");
              if (!cur) r.by = me.username;
              if (cur && r.status && r.status !== cur.status) {
                if (cur.by === me.username) throw demoErr("You can't approve or reject your own count. Another manager or the Senior Admin must do it.");
                r.decidedBy = me.username;
              }
            });
          }
          if (op.op === "upsert" && op.expect) {
            op.rows.forEach(function (r) {
              var cur = work[op.sheet].find(function (x) { return x[KEYS[op.sheet]] === r[KEYS[op.sheet]]; });
              var nowS = cur ? String(cur[op.expect.field]) : "";
              if (op.expect.values.indexOf(nowS) < 0) throw demoErr("Job " + r[KEYS[op.sheet]] + " was already moved on (now '" + (nowS || "missing") + "'), probably on another device. Refresh.");
            });
          }
          if (op.op === "replaceLines") {
            var j = work.Jobs.find(function (x) { return x.no === op.job; });
            if (j && j.status !== "quoted") throw demoErr("Job " + op.job + " is already kitted. Its quote materials can't change now.");
          }
          if (op.op === "append") {
            var have = {}; work.Moves.forEach(function (m) { have[m.id] = 1; });
            op.rows = op.rows.filter(function (m) { return !have[m.id]; }).map(function (m) { return Object.assign({}, m, { by: me.username }); });
            newMoves = newMoves.concat(op.rows);
          }
          applyOpsLocal(work, [op]);
        });
        var items = {}; work.Items.forEach(function (i) { items[i.sku] = i; });
        var problem = C.checkBalances(d.Moves, newMoves, items);
        if (problem) throw demoErr(problem);
        d = work; done[body.batch] = assigned;
        LS.set("sc_demo", d); LS.set("sc_demo_batches", done);
      }
    }
    if (!LS.get("sc_demo", null)) LS.set("sc_demo", d);
    var out = JSON.parse(JSON.stringify(d)), have2 = Number(body.have) || 0, total = out.Moves.length;
    var from = have2 > 0 && have2 <= total ? have2 : 0;
    out.Moves = out.Moves.slice(from); out.movesFrom = from; out.movesTotal = total;
    if (me.role === "admin") out.Users = this.listUsers(users);
    return { ok: true, assigned: assigned, data: out, user: this.publicUser(me) };
  }
};
function netError() { var e = new Error("No signal. Your change is saved on this phone and will sync automatically."); e.net = true; return e; }
function post(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) })
    .then(function (res) { return res.text(); }, function () { throw netError(); })
    .then(function (t) {
      var j;
      try { j = JSON.parse(t); } catch (e) { var er = new Error("The Google Sheet didn't answer properly. Check the web app link."); er.net = true; throw er; }
      if (!j.ok) { var e2 = new Error(j.error || "Refused."); e2.signIn = !!j.signIn; throw e2; }
      return j;
    });
}
var api = {
  call: function (action, body) {
    body = Object.assign({ action: action, token: cfg.token || "" }, body || {});
    var p = cfg.mode === "demo" ? demo.call(action, body) : post(cfg.url, body);
    return p.catch(function (e) { if (e.signIn) signedOut(e.message); throw e; });
  },
  sync: function (ops, batch, have) {
    return api.call("sync", { ops: ops || [], batch: batch || "", have: have == null ? SD.Moves.length : have }).then(function (res) {
      if (res.user) { cfg.user = res.user; saveCfg(); }
      return res;
    });
  }
};
// The Sheet said this sign-in is no longer valid. Keep queued work; ask to sign in again.
function signedOut(msg) {
  cfg.token = ""; saveCfg(); stopCam();
  S.loginMsg = msg; S.tab = "jobs"; S.sub = null; S.job = null; S.item = null; S.f = {};
  setTimeout(render, 0);
}

// Take the Sheet's answer into SD. Movements arrive as "only the new ones" when possible.
function applyServer(res) {
  var d = res.data;
  TABS.forEach(function (t) { if (t !== "Moves") SD[t] = d[t] || []; });
  if (d.Users) S.users = d.Users;
  if (d.movesFrom === 0) SD.Moves = d.Moves;
  else if (d.movesFrom === SD.Moves.length) SD.Moves = SD.Moves.concat(d.Moves);
  else { SD.Moves = []; return false; } // out of step: caller does a full reload
  persist(); rebuild();
  return true;
}

/* ===================== helpers ===================== */
var $ = function (s) { return document.querySelector(s); };
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
function R(v) { var x = Math.round(n(v)); return (x < 0 ? "\u2212R\u00a0" : "R\u00a0") + Math.abs(x).toLocaleString("en-ZA"); }
var UNIT = { m: { short: "m", long: "metres", per: "metre" }, "in": { short: "in", long: "inches", per: "inch" }, ea: { short: "", long: "units", per: "unit" } };
function isLen(u) { return u === "m" || u === "in"; }
function unitOfSku(sku) { var u = X.items[sku] && X.items[sku].uom; return UNIT[u] ? u : "ea"; }
function q(v, sku) { var u = unitOfSku(sku); var s = (Math.round(n(v) * 100) / 100).toLocaleString("en-ZA", { maximumFractionDigits: 2 }); return u === "ea" ? s : s + "\u00a0" + UNIT[u].short; }
function unitHint(sku) { var u = unitOfSku(sku); return u === "ea" ? "" : " (" + UNIT[u].short + ")"; }
function cost(sku) { return n(X.items[sku] && X.items[sku].cost); }
function nameOf(sku) { return (X.items[sku] && X.items[sku].name) || sku; }
function vanName(id) { var v = D.Vans.find(function (x) { return x.id === id; }); return v ? v.name : (id || ""); }
function isSerial(sku) { return X.items[sku] && X.items[sku].track === "serial"; }
function dshort(s) { return s ? new Date(s).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : ""; }
function dtime(s) { return s ? new Date(s).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; }
function now() { return new Date().toISOString(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function mv(type, sku, qty, from, to, extra) {
  return Object.assign({ id: uid(), ts: now(), type: type, sku: sku, qty: C.round2(qty), from: from, to: to, by: (cfg.user && cfg.user.username) || "",
    value: C.round2(n(qty) * cost(sku)) }, extra || {});
}
function bal(loc, sku) { return C.bal(X.B, loc, sku); }
function linesOf(no) { return D.Lines.filter(function (l) { return l.job === no; }); }
function qrImg(text, cell) { try { var qr = qrcode(0, "M"); qr.addData(text); qr.make(); return qr.createDataURL(cell || 5, 2); } catch (e) { return ""; } }
function labelLink(code) { return siteUrl() + "?c=" + encodeURIComponent(code); }
// Where is a serial number now? (last movement that carried it)
function serialPlace(serial) {
  var at = null;
  D.Moves.forEach(function (m) { if (m.serial && String(m.serial).toUpperCase() === serial) at = m.to; });
  return at;
}
var ROLE_LABEL = { admin: "Senior Admin", manager: "Warehouse Manager", storeman: "User", viewer: "Viewer" };
function role() { return (cfg.user && cfg.user.role) || ""; }
function isAdmin() { return role() === "admin"; }                          // Senior Admin: logins, connection
function isMgrRole(r) { return r === "admin" || r === "manager"; }
function canManage() { return role() === "admin" || role() === "manager"; }  // inventory, items, costs, corrections
function canWork() { return role() === "admin" || role() === "manager" || role() === "storeman"; }
function hubName() { return isAdmin() ? "Admin" : canManage() ? "Manage" : "More"; }
var STATUS = { quoted: "Quoted", kitted: "Ready for van", out: "On site", closed: "Closed" };

/* ===================== screen state ===================== */
var S = { tab: "jobs", sub: null, job: null, f: {}, msg: null, busy: false, scanFor: null, loading: true };
function flash(k, t) { S.msg = { k: k, t: t }; render(); }
function msgHtml() { return S.msg ? '<div class="msg ' + S.msg.k + '" role="status">' + esc(S.msg.t) + "</div>" : ""; }
function go(tab, extra) {
  if (tab !== "scan" && !(S.scanFor && tab === "jobs")) stopCam();
  S.tab = tab; S.sub = null; S.job = null; S.item = null; S.msg = null; S.f = {};
  Object.assign(S, extra || {});
  render(); window.scrollTo(0, 0);
}
function setStatus(k, t) { $("#dot").className = "dot " + (k || ""); $("#statusText").textContent = t; }
function syncStatus() {
  var who = $("#who");
  if (who) { who.hidden = !(cfg.token && cfg.user); if (cfg.user) who.textContent = cfg.user.name + " · " + ROLE_LABEL[cfg.user.role]; }
  if (!cfg.mode) return setStatus("", "Not connected");
  if (!cfg.token) return setStatus("", "Signed out");
  if (Q.length) return setStatus("err", Q.length + (Q.length === 1 ? " change" : " changes") + " waiting to sync");
  setStatus("ok", cfg.mode === "demo" ? "Demo" : "Up to date " + new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }));
}

/*
 * save(): most changes are queued on the phone first, shown straight away, and sent in the background.
 * opts.online = must reach the Sheet now (new jobs, stickers, vans need a number from the Sheet).
 */
function save(ops, okMsg, after, opts) {
  opts = opts || {};
  if (opts.online) {
    S.busy = true; render();
    return api.sync(ops, uid()).then(function (res) {
      if (!applyServer(res)) return fullReload();
      S.msg = { k: "ok", t: okMsg };
      if (after) after(res.assigned || {});
    }).catch(function (e) {
      if (e.signIn) return;
      S.msg = { k: "err", t: e.net ? "This needs signal (the Sheet hands out the number). Try again when you're connected." : e.message };
    }).then(function () { S.busy = false; syncStatus(); render(); });
  }
  // check stock against what this phone knows, before queueing
  var newMoves = [];
  ops.forEach(function (op) { if (op.op === "append") newMoves = newMoves.concat(op.rows); });
  var problem = C.checkBalances(D.Moves, newMoves, X.items);
  if (problem) return flash("err", problem);
  Q.push({ batch: uid(), ops: ops, label: okMsg, ts: now(), user: (cfg.user && cfg.user.username) || "" });
  persist(); rebuild();
  S.msg = { k: "ok", t: okMsg };
  if (after) after({});
  syncStatus(); render();
  flush();
  return Promise.resolve();
}

var flushing = false;
function flush() {
  if (flushing || !Q.length || !cfg.mode || !cfg.token) return;
  flushing = true;
  var b = Q[0];
  api.sync(b.ops, b.batch).then(function (res) {
    Q.shift();
    if (!applyServer(res)) { persist(); flushing = false; return fullReload(); }
    flushing = false;
    if (Q.length) flush(); else { syncStatus(); render(); }
  }).catch(function (e) {
    flushing = false;
    if (e.net || e.signIn) { syncStatus(); return; }      // no signal or signed out: keep it, try again later
    // The Sheet refused it (e.g. stock used on another device). Drop it and tell the person.
    Q.shift(); persist();
    S.msg = { k: "err", t: "Not saved: " + b.label + " Reason: " + e.message };
    fullReload();
  });
}
function fullReload() {
  if (!cfg.mode || !cfg.token) { S.loading = false; syncStatus(); render(); return Promise.resolve(); }
  return api.sync([], "", 0).then(function (res) {
    SD.Moves = []; applyServer(res); S.loading = false; syncStatus(); render(); flush();
  }).catch(function (e) {
    S.loading = false;
    if (!e.net && !e.signIn) S.msg = { k: "err", t: e.message };
    syncStatus(); if (!Q.length && e.net) setStatus("err", "Offline: showing saved data");
    render();
  });
}
function pull() {
  if (!cfg.mode || !cfg.token || flushing || Q.length) return flush();
  api.sync([], "").then(function (res) { if (!applyServer(res)) return fullReload(); syncStatus(); render(); }).catch(function () { syncStatus(); });
}
function reload() {
  rebuild();
  if (!cfg.mode || !cfg.token) { S.loading = false; syncStatus(); render(); return Promise.resolve(); }
  if (SD.Moves.length || SD.Items.length) { S.loading = false; render(); }   // show saved data at once
  setStatus("", "Syncing…");
  return (Q.length ? Promise.resolve(flush()) : api.sync([], "").then(function (res) { if (!applyServer(res)) return fullReload(); }))
    .catch(function (e) { if (!e.net && !e.signIn) S.msg = { k: "err", t: e.message }; })
    .then(function () { S.loading = false; syncStatus(); if (!Q.length && !navigator.onLine) setStatus("err", "Offline: showing saved data"); render(); });
}
window.addEventListener("online", flush);
setInterval(function () { if (Q.length) flush(); }, 30000);

/* ===================== render ===================== */
/*
 * Back / Forward: every screen change is recorded in the browser history, so the
 * header buttons, the phone's own back gesture and the browser buttons all work.
 */
var NAV = { idx: 0, max: 0, key: null, restoring: false };
function viewKey() { return JSON.stringify({ t: S.tab, s: S.sub || null, j: S.job || null, i: S.item || null, v: (S.f && S.f.invTab) || null }); }
function recordNav() {
  var key = viewKey();
  if (key === NAV.key) return;
  if (NAV.key === null || NAV.restoring) { NAV.key = key; try { history.replaceState({ sc: key, idx: NAV.idx }, ""); } catch (e) {} return; }
  NAV.idx++; NAV.max = NAV.idx; NAV.key = key;
  try { history.pushState({ sc: key, idx: NAV.idx }, ""); } catch (e) {}
}
window.addEventListener("popstate", function (e) {
  if (!e.state || !e.state.sc) return;
  var v = JSON.parse(e.state.sc);
  stopCam(); S.scanFor = null;
  S.tab = v.t; S.sub = v.s; S.job = v.j; S.item = v.i; S.f = v.v ? { invTab: v.v } : {}; S.msg = null;
  NAV.idx = e.state.idx || 0; NAV.key = e.state.sc;
  NAV.restoring = true; render(); NAV.restoring = false;
  window.scrollTo(0, 0);
});
function updateToolbar(ready) {
  $("#toolbar").hidden = !cfg.mode;
  $("#navBack").hidden = $("#navFwd").hidden = !ready;
  $("#navBack").disabled = NAV.idx <= 0;
  $("#navFwd").disabled = NAV.idx >= NAV.max;
  $("#navHome").hidden = !(cfg.token && cfg.user);
  if (!(cfg.token && cfg.user)) $("#homeConfirm").hidden = true;
  $("#ver").textContent = "v" + APP_VERSION;
}

function render() {
  var signedIn = !!(cfg.mode && cfg.token && cfg.user);
  var ready = signedIn && !cfg.user.mustChange;
  if (ready && !S.loading) recordNav();
  updateToolbar(ready);
  var nav = document.querySelector("nav.tabs");
  nav.hidden = !ready;
  document.body.classList.toggle("nonav", !ready);
  document.querySelectorAll("nav.tabs button").forEach(function (b) {
    var t = b.dataset.tab;
    b.hidden = (t === "scan" || t === "counts") && !canWork();
    b.classList.toggle("on", t === S.tab && t !== "scan");
    if (t === "more") b.lastChild.textContent = hubName();
  });
  if (!canWork() && (S.tab === "scan" || S.tab === "counts")) S.tab = "jobs";
  $("#demoBar").hidden = cfg.mode !== "demo";
  if (cfg.mode === "demo") $("#demoBar").innerHTML = demoKind() === "empty"
    ? "Test mode: your own data, saved only on this phone. When you're ready, a Senior Admin connects the real Google Sheet in <b>Admin → My account</b>."
    : "Demo mode: made-up example stock and jobs, saved only on this phone. A Senior Admin can <b>Start empty</b> or connect the real Google Sheet in <b>Admin → My account</b>.";
  syncStatus();
  var v = $("#view");
  var html;
  if (!cfg.mode) html = vWelcome();
  else if (!signedIn) html = vLogin();
  else if (cfg.user.mustChange) html = vChangePinFirst();
  else if (S.loading) html = '<p class="muted">Loading stock…</p>';
  else html = ({ jobs: vJobs, stock: vStock, scan: vScan, counts: vCounts, more: vMore })[S.tab]();
  // keep what the person was typing
  var a = document.activeElement, id = a && a.id, pos = null;
  try { pos = a && a.selectionStart; } catch (e) {}
  v.innerHTML = html;
  patchReturn(); patchCounts();
  if (id) { var el = document.getElementById(id); if (el && el.tagName !== "BUTTON") { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) {} } }
}

function vWelcome() {
  return '<section class="panel login"><h2>Welcome</h2>' +
    '<p>Every metre that leaves the store is tied to a job, and has to come back or be explained.</p>' +
    '<button class="btn wide" data-action="startDemo">Try it with example data</button>' +
    '<button class="btn ghost wide" data-action="goLive">Connect our Google Sheet</button>' +
    '<p class="small muted">Demo data stays on this phone only. You can switch any time.</p></section>';
}

/* ---------- Jobs ---------- */
function vJobs() {
  if (S.sub === "new") return vJobForm();
  if (S.job && X.jobs[S.job]) return vJob(X.jobs[S.job]);
  var groups = { quoted: [], kitted: [], out: [], closed: [] };
  D.Jobs.slice().sort(function (a, b) { return b.no.localeCompare(a.no); }).forEach(function (j) { (groups[j.status] || groups.quoted).push(j); });
  function card(j) {
    var right = "";
    if (j.status === "out" || j.status === "kitted") {
      var out = C.jobSummary(j.no, D.Lines, D.Moves, X.items).reduce(function (s, r) { return s + Math.max(0, r.outstanding) * r.cost; }, 0);
      right = '<span class="mono small">' + R(out) + " out</span>";
    } else if (j.status === "closed") {
      right = n(j.missingValue) > 0 ? '<span class="pill p-bad">' + R(j.missingValue) + " missing</span>" : '<span class="small muted">All accounted</span>';
    }
    return '<button class="card" data-action="openJob" data-job="' + esc(j.no) + '"><div><div class="no">' + esc(j.no) + "</div><div>" + esc(j.client) + "</div>" +
      '<div class="tiny muted">' + esc(j.type) + " · " + esc(vanName(j.van)) + " · " + esc(j.installer) + "</div></div>" +
      '<div class="right"><span class="pill p-' + esc(j.status) + '">' + STATUS[j.status] + "</span>" + right + "</div></button>";
  }
  function sec(title, list, hint, limit) {
    if (!list.length) return "";
    return '<section class="list"><div class="spread"><h3>' + title + ' <span class="muted">(' + list.length + ")</span></h3>" +
      (hint ? '<span class="tiny muted">' + hint + "</span>" : "") + "</div>" + list.slice(0, limit || 99).map(card).join("") + "</section>";
  }
  return '<div class="spread"><h2>Jobs</h2>' + (canWork() ? '<button class="btn small" data-action="newJob">+ New job</button>' : "") + "</div>" + msgHtml() +
    sec("To kit", groups.quoted, "Pick these into a crate") +
    sec("Ready for van", groups.kitted, "Scan the crate when collected") +
    sec("On site", groups.out, "Check the crate when it comes back") +
    sec("Closed", groups.closed, "Latest 10", 10) +
    (D.Jobs.length ? "" : '<p class="muted">No jobs yet.' + (canWork() ? " Start with + New job and copy the materials from the quote." : "") + "</p>");
}

function vJobForm() {
  var f = S.f.nj || (S.f.nj = { client: "", type: "", van: "", installer: "", quoteRef: "", lines: [{ sku: "", quoted: "" }] });
  var items = D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var lineRows = f.lines.map(function (l, i) {
    return '<div class="row"><label class="f" style="flex:3 1 180px">Item<select id="nl_sku_' + i + '" data-bind="nj.lines.' + i + '.sku">' +
      '<option value="">Choose…</option>' + items.map(function (it) { return '<option value="' + esc(it.sku) + '"' + (it.sku === l.sku ? " selected" : "") + ">" + esc(it.name) + "</option>"; }).join("") +
      '</select></label><label class="f" style="flex:1 1 90px">Quoted' + (l.sku ? unitHint(l.sku) : "") +
      '<input class="num" id="nl_q_' + i + '" type="number" inputmode="decimal" min="0" step="any" value="' + esc(l.quoted) + '" data-bind="nj.lines.' + i + '.quoted"></label>' +
      '<button class="btn ghost small" data-action="delLine" data-i="' + i + '" aria-label="Remove line">✕</button></div>';
  }).join("");
  return '<div class="row"><button class="btn ghost small" data-action="back">← Jobs</button></div>' +
    "<h2>" + (f.no ? "Edit " + esc(f.no) : "New job") + "</h2>" +
    '<section class="panel"><h3>Job</h3><div class="row">' +
    '<label class="f">Client / site<input id="nj_client" value="' + esc(f.client) + '" data-bind="nj.client" placeholder="e.g. Botha, Durbanville"></label>' +
    '<label class="f">Job type<input id="nj_type" value="' + esc(f.type) + '" data-bind="nj.type" placeholder="e.g. 5 kW hybrid rooftop"></label></div><div class="row">' +
    '<label class="f">Van<select id="nj_van" data-bind="nj.van"><option value="">Choose…</option>' + X.vans.map(function (v) { return '<option value="' + esc(v.id) + '"' + (v.id === f.van ? " selected" : "") + ">" + esc(v.name) + "</option>"; }).join("") + "</select></label>" +
    '<label class="f">Lead installer<input id="nj_inst" value="' + esc(f.installer) + '" data-bind="nj.installer"></label>' +
    '<label class="f">Quote number<input id="nj_quote" value="' + esc(f.quoteRef) + '" data-bind="nj.quoteRef" placeholder="e.g. Q-2219"></label></div></section>' +
    '<section class="panel"><h3>Materials on the quote</h3><p class="small muted">Copy the quantities from the quote. The kit adds a cable allowance automatically.</p>' +
    lineRows + '<button class="btn ghost small" data-action="addLine">+ Add item</button></section>' +
    msgHtml() + '<button class="btn wide" data-action="saveJob"' + (S.busy ? " disabled" : "") + ">" + (f.no ? "Save changes" : "Create job") + "</button>";
}

function steps(status) {
  var order = ["quoted", "kitted", "out", "closed"], at = order.indexOf(status);
  return '<div class="steps" aria-hidden="true">' + order.map(function (s, i) { return '<span class="' + (i <= at ? "on" : "") + '"></span>'; }).join("") + "</div>";
}

function vJob(j) {
  var sum = C.jobSummary(j.no, D.Lines, D.Moves, X.items);
  var head = '<div class="row"><button class="btn ghost small" data-action="back">← Jobs</button></div>' +
    '<div class="spread"><div><div class="eyebrow">' + esc(j.no) + (j.quoteRef ? " · Quote " + esc(j.quoteRef) : "") + "</div><h2>" + esc(j.client) + "</h2>" +
    '<div class="small muted">' + esc(j.type) + " · " + esc(vanName(j.van)) + " · " + esc(j.installer) + "</div></div>" +
    '<span class="pill p-' + esc(j.status) + '">' + STATUS[j.status] + "</span></div>" + steps(j.status);
  var body = "";
  if (!canWork() && j.status !== "closed") body = '<p class="small muted">View only. ' + STATUS[j.status] + ".</p>" + summaryTable(sum, false);
  else if (j.status === "quoted") body = vKit(j, sum);
  else if (j.status === "kitted") body = vCollect(j, sum);
  else if (j.status === "out") body = vReturn(j, sum);
  else body = vClosed(j, sum);
  return head + msgHtml() + body;
}

function vKit(j, sum) {
  var k = S.f.kit || (S.f.kit = {});
  var rows = sum.filter(function (r) { return r.quoted > 0; }).map(function (r) {
    var it = X.items[r.sku] || {}, wh = bal("WH", r.sku);
    if (k[r.sku] === undefined) k[r.sku] = String(C.kitDefault(it, r.quoted));
    var ser = isSerial(r.sku);
    var sers = (S.f.serials && S.f.serials[r.sku]) || [];
    var short = n(k[r.sku]) > wh + 1e-9;
    return "<tr><td>" + esc(nameOf(r.sku)) + (ser ? '<div class="serials" style="margin-top:4px">' + sers.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") +
      '</div><button class="btn ghost small" style="margin-top:6px" data-action="scanSerials" data-sku="' + esc(r.sku) + '">Scan serials (' + sers.length + "/" + n(k[r.sku]) + ")</button>" : "") +
      '</td><td class="n">' + q(r.quoted, r.sku) + '</td><td class="n" style="min-width:96px"><input class="num" id="kit_' + esc(r.sku) + '" type="number" inputmode="decimal" min="0" step="any" value="' + esc(k[r.sku]) + '" data-bind="kit.' + esc(r.sku) + '"></td>' +
      '<td class="n">' + (short ? '<span class="pill p-bad">' + q(wh, r.sku) + "</span>" : q(wh, r.sku)) + "</td></tr>";
  }).join("");
  return '<section class="panel"><h3>1. Pick the kit into a crate</h3>' +
    '<p class="small muted">Kit = quote plus cable allowance. Change it if needed. Panels and inverters: scan each serial number.</p>' +
    '<div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">Quoted</th><th class="n">Kit</th><th class="n">In store</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    '<button class="btn wide" data-action="recordKit"' + (S.busy ? " disabled" : "") + ">Kit is packed</button>" +
    '<button class="btn ghost small" data-action="editJob">Edit quote materials</button></section>';
}

function crateLabel(j) {
  return '<div class="qrbig"><img src="' + qrImg(labelLink(j.no), 6) + '" alt="Crate label for ' + esc(j.no) + '"><div class="mono">' + esc(j.no) + '</div><div class="small">' + esc(j.client) + "</div></div>";
}
function vCollect(j, sum) {
  return '<section class="panel"><h3>2. Van collects the crate</h3>' +
    '<p class="small">Stick this label on the crate. When the van collects, scan it, or tap the button.</p>' + crateLabel(j) +
    '<div class="row noprint"><button class="btn ghost small" data-action="printCrate">Print crate label</button></div>' +
    '<button class="btn wide" data-action="collected"' + (S.busy ? " disabled" : "") + ">Van " + esc(vanName(j.van)) + " collected it</button></section>" +
    summaryTable(sum, false);
}

function returnState(sum) {
  var f = S.f.ret || (S.f.ret = {});
  var st = { lines: [], missVal: 0, allUsed: true, over: false };
  sum.filter(function (r) { return r.outstanding > 1e-9; }).forEach(function (r) {
    var x = f[r.sku] || (f[r.sku] = { ret: "", scrap: "", used: "" });
    var miss = C.round2(r.outstanding - n(x.ret) - n(x.scrap) - n(x.used));
    if (x.used === "") st.allUsed = false;
    if (miss < -1e-9) st.over = true;
    if (x.used !== "" && miss > 1e-9) st.missVal += miss * r.cost;
    st.lines.push({ r: r, x: x, miss: miss });
  });
  return st;
}
function missCell(l) {
  return l.x.used === "" ? "–" : l.miss > 1e-9 ? '<span class="pill p-bad">' + q(l.miss, l.r.sku) + "</span>" : l.miss < -1e-9 ? '<span class="pill p-bad">Too much</span>' : "0";
}
function vReturn(j, sum) {
  var st = returnState(sum), f = S.f.ret;
  var rows = st.lines.map(function (l) {
    var r = l.r;
    function inp(key, label) {
      return "<label>" + label + '<input class="num" id="ret_' + key + "_" + esc(r.sku) + '" type="number" inputmode="decimal" min="0" step="any" value="' + esc(l.x[key]) +
        '" data-bind="ret.' + esc(r.sku) + "." + key + '" data-live="1" aria-label="' + label + " " + esc(nameOf(r.sku)) + '"></label>';
    }
    return '<div class="rline"><div class="spread"><b>' + esc(nameOf(r.sku)) + '</b><span class="small">Out <b class="mono">' + q(r.outstanding, r.sku) + '</b> · Missing <span id="miss_' + esc(r.sku) + '" class="mono">' + missCell(l) + "</span></span></div>" +
      '<div class="ins">' + inp("ret", "Back in store") + inp("scrap", "Scrap") + inp("used", "Used") + "</div></div>";
  }).join("");
  return '<section class="panel"><div class="spread"><h3>3. Crate back: check every line</h3><button class="btn ghost small" data-action="extra">+ Extra stock</button></div>' +
    '<p class="small muted">Measure what came back. Usable goes back in store, short offcuts go to scrap. "Used" is what the installer says was installed. Whatever is left over is missing.</p>' +
    rows + '<div id="retNote"></div>' +
    '<label class="f" id="retReasonBox" hidden>Why didn\'t it come back? (required)<input id="ret_reason" value="' + esc(f.reason || "") + '" data-bind="ret.reason" placeholder="e.g. Offcuts left on site"></label>' +
    '<button class="btn wide" data-action="closeJob" id="closeBtn">Close job</button></section>' +
    summaryTable(sum, false);
}
function patchReturn() {
  var j = X.jobs[S.job]; if (!j || j.status !== "out" || !$("#closeBtn")) return;
  var st = returnState(C.jobSummary(j.no, D.Lines, D.Moves, X.items));
  st.lines.forEach(function (l) { var c = document.getElementById("miss_" + l.r.sku); if (c) c.innerHTML = missCell(l); });
  var note = "";
  if (st.over) note = '<div class="msg err">A line adds up to more than what went out. Check the numbers.</div>';
  else if (!st.allUsed) note = '<p class="tiny muted">Fill in "Used" on every line to close. Blank Back or Scrap counts as 0.</p>';
  else if (st.missVal > 0) note = '<div class="msg warn">Closing will record ' + R(st.missVal) + " as missing, charged to this job, van and installer.</div>";
  else note = '<div class="msg ok">Everything is accounted for.</div>';
  $("#retNote").innerHTML = note;
  $("#retReasonBox").hidden = !(st.allUsed && !st.over && st.missVal > 0);
  $("#closeBtn").disabled = !st.allUsed || st.over || S.busy;
}

function vClosed(j, sum) {
  var flags = C.overQuote(sum, 10);
  return (n(j.missingValue) > 0 ? '<div class="msg err">Closed with ' + R(j.missingValue) + " missing. Reason: " + esc(j.reason || "—") + "</div>" : '<div class="msg ok">Closed. Every item accounted for.</div>') +
    (flags.length ? '<div class="msg warn">Used more than quoted: ' + flags.map(function (f) { return esc(nameOf(f.sku)) + " +" + Math.round(f.overPct) + "%"; }).join(", ") + ". If this keeps happening for this job type, the quotes are too low.</div>" : "") +
    summaryTable(sum, true);
}

function summaryTable(sum, full) {
  if (!sum.length) return "";
  return '<section class="panel"><h3>' + (full ? "Quote vs actual" : "Materials on this job") + '</h3><div class="tablewrap"><table class="sumt"><thead><tr><th>Item</th><th class="n">Quoted</th><th class="n">Issued</th><th class="n">Back</th><th class="n">Scrap</th><th class="n">Used</th><th class="n">Missing</th></tr></thead><tbody>' +
    sum.map(function (r) {
      return "<tr><td>" + esc(nameOf(r.sku)) + (r.extra > 0 ? '<div class="tiny muted">incl. ' + q(r.extra, r.sku) + " extra</div>" : "") + '</td><td class="n">' + q(r.quoted, r.sku) + '</td><td class="n">' + q(r.issued, r.sku) +
        '</td><td class="n">' + q(r.returned, r.sku) + '</td><td class="n">' + q(r.scrap, r.sku) + '</td><td class="n">' + q(r.used, r.sku) + '</td><td class="n">' +
        (r.missing > 0 ? '<span class="pill p-bad">' + q(r.missing, r.sku) + "</span>" : "0") + "</td></tr>";
    }).join("") + "</tbody></table></div></section>";
}

/* ---------- Scan ---------- */
function vScan() {
  var f = S.f;
  if (S.scanFor) {
    var list = (S.f.serials && S.f.serials[S.scanFor.sku]) || [];
    return '<section class="panel"><h3>Scanning serials: ' + esc(nameOf(S.scanFor.sku)) + "</h3>" +
      '<p class="small">' + list.length + " of " + S.scanFor.need + ' scanned.</p><div class="serials">' + list.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>" +
      '<div class="row"><label class="f">Or type a serial<input class="code" id="ser_manual" data-bind="serManual"></label><button class="btn ghost" data-action="addSerial">Add</button></div>' +
      msgHtml() + '<button class="btn wide" data-action="doneSerials">Done</button></section>';
  }
  var it = f.sku ? X.items[f.sku] : null;
  var html = '<h2>Scan</h2>' +
    '<section class="panel"><button class="btn wide" data-action="startCam">Open camera</button>' +
    '<div class="row"><label class="f">Or type a sticker, job or item code<input class="code" id="sc_code" data-bind="code" value="' + esc(f.code || "") + '" placeholder="GS-0001 or J-1003" autocomplete="off"></label>' +
    '<button class="btn ghost" data-action="lookup">Go</button></div>' + (it ? "" : msgHtml()) + "</section>";
  if (!it) return html + '<p class="small muted">Scan a <b>crate label</b> to open its job. Scan a <b>shelf or drum sticker</b> to receive stock, issue extra to a job, or top up a van.</p>';
  var mode = f.mode || "receive";
  var serial = isSerial(it.sku), wh = bal("WH", it.sku);
  var modes = { receive: "Receive", extra: "Extra to job", topup: "Van top-up" };
  var form = '<section class="panel"><div><div class="eyebrow">' + esc(it.sku) + (f.label ? " · sticker " + esc(f.label) : "") + "</div><h3>" + esc(it.name) + "</h3>" +
    '<div class="small muted">In store: <b class="mono">' + q(wh, it.sku) + "</b></div></div>" +
    '<div class="row" role="radiogroup" aria-label="What is happening">' + Object.keys(modes).map(function (m) {
      return '<button class="btn small ' + (m === mode ? "" : "ghost") + '" role="radio" aria-checked="' + (m === mode) + '" data-action="mode" data-mode="' + m + '">' + modes[m] + "</button>";
    }).join("") + "</div>";
  var sers = (f.serials && f.serials[it.sku]) || [];
  if (mode === "receive") {
    form += '<div class="row"><label class="f">Quantity' + unitHint(it.sku) + '<input class="num" id="rc_qty" type="number" inputmode="decimal" min="0" step="any" data-bind="qty" value="' + esc(serial ? sers.length || "" : f.qty || "") + '"' + (serial ? " readonly" : "") + "></label>" +
      '<label class="f">Landed cost per ' + UNIT[unitOfSku(it.sku)].per + ' (R, excl. VAT)<input class="num" id="rc_cost" type="number" inputmode="decimal" min="0" step="any" data-bind="cost" value="' + esc(f.cost != null ? f.cost : (n(it.cost) || "")) + '"></label></div>' +
      '<label class="f">Shipment or invoice ref<input id="rc_ref" data-bind="ref" value="' + esc(f.ref || "") + '" placeholder="e.g. Container MSKU 12345"></label>' +
      '<p class="tiny muted">Landed cost = supplier price + freight + duty + clearing, per unit, all excluding VAT (the business claims VAT back).</p>' +
      (serial ? '<div class="serials">' + sers.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + '</div><button class="btn ghost small" data-action="scanSerials" data-sku="' + esc(it.sku) + '" data-need="999">Scan serial numbers (' + sers.length + ")</button>" : "");
  } else if (mode === "extra") {
    var jobs = D.Jobs.filter(function (j) { return j.status === "out" || j.status === "kitted"; });
    form += '<div class="row"><label class="f">Quantity' + unitHint(it.sku) + '<input class="num" id="ex_qty" type="number" inputmode="decimal" min="0" step="any" data-bind="qty" value="' + esc(f.qty || "") + '"></label>' +
      '<label class="f">Job<select id="ex_job" data-bind="job"><option value="">Choose…</option>' + jobs.map(function (j) { return '<option value="' + esc(j.no) + '"' + (j.no === f.job ? " selected" : "") + ">" + esc(j.no) + " · " + esc(j.client) + "</option>"; }).join("") + "</select></label></div>" +
      '<label class="f">Reason (required)<input id="ex_reason" data-bind="reason" value="' + esc(f.reason || "") + '" placeholder="e.g. Longer run to DB board than quoted"></label>';
  } else {
    form += '<div class="row"><label class="f">Quantity<input class="num" id="tu_qty" type="number" inputmode="decimal" min="0" step="any" data-bind="qty" value="' + esc(f.qty || "") + '"></label>' +
      '<label class="f">Van<select id="tu_van" data-bind="van"><option value="">Choose…</option>' + X.vans.map(function (v) { return '<option value="' + esc(v.id) + '"' + (v.id === f.van ? " selected" : "") + ">" + esc(v.name) + "</option>"; }).join("") + "</select></label></div>";
  }
  form += msgHtml() + '<button class="btn wide" data-action="postMove"' + (S.busy ? " disabled" : "") + ">Save " + modes[mode].toLowerCase() + "</button></section>";
  return html + form;
}

/* ---------- Stock ---------- */
function vStock() {
  if (S.item && X.items[S.item]) return vItemHistory(S.item);
  var vanIds = X.vans.map(function (v) { return v.id; });
  var whVal = 0, vanVal = 0, jobVal = 0;
  var rows = D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (it) {
    var wh = bal("WH", it.sku), vv = 0, jb = 0;
    vanIds.forEach(function (v) { vv += bal(v, it.sku); });
    Object.keys(X.B).forEach(function (l) { if (l.indexOf("JOB:") === 0) jb += bal(l, it.sku); });
    whVal += wh * cost(it.sku); vanVal += vv * cost(it.sku); jobVal += jb * cost(it.sku);
    var low = n(it.reorder) > 0 && wh < n(it.reorder);
    return '<tr><td><button class="linkbtn" data-action="itemHistory" data-sku="' + esc(it.sku) + '">' + esc(it.name) + '</button><div class="tiny muted mono">' + esc(it.sku) + "</div></td>" +
      '<td class="n">' + q(wh, it.sku) + (low ? ' <span class="pill p-kitted">Order</span>' : "") + (wh < -1e-9 ? ' <span class="pill p-bad">Check</span>' : "") + "</td>" +
      '<td class="n">' + q(vv, it.sku) + '</td><td class="n">' + q(jb, it.sku) + '</td><td class="n">' + R((wh + vv + jb) * cost(it.sku)) + "</td></tr>";
  }).join("");
  var seesLoss = role() === "admin" || role() === "viewer";
  var L = C.losses(D.Moves, 30);
  var low = D.Items.filter(function (it) { return n(it.reorder) > 0 && bal("WH", it.sku) < n(it.reorder); });
  return "<h2>Stock</h2>" + msgHtml() +
    '<div class="kpis">' + (seesLoss ? '<button class="kpi kpibtn" data-action="sub" data-tab2="more" data-sub="reports"><div class="l">Missing, last 30 days ›</div><div class="v ' + (L.total > 0 ? "bad" : "") + '">' + R(L.total) + "</div></button>" :
      '<div class="kpi"><div class="l">Items to order</div><div class="v' + (low.length ? " bad" : "") + '">' + low.length + "</div></div>") +
    '<div class="kpi"><div class="l">In store</div><div class="v">' + R(whVal) + '</div></div><div class="kpi"><div class="l">In vans</div><div class="v">' + R(vanVal) + "</div></div>" +
    '<div class="kpi"><div class="l">Out on jobs</div><div class="v">' + R(jobVal) + "</div></div></div>" +
    '<section class="panel"><h3>Stock on hand</h3><div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">Store</th><th class="n">Vans</th><th class="n">Jobs</th><th class="n">Value</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    '<p class="tiny muted">Value uses the average landed cost of each item. Tap an item to see every movement' + (canManage() ? " and correct mistakes." : ".") + "</p></section>";
}

/* ---------- Item history & corrections ---------- */
var MOVE_LABEL = { adjust: "Adjustment", receive: "Received", kit: "Kitted to job", extra: "Extra to job", "return": "Returned", scrap: "Scrapped", used: "Used on job",
  missing: "Missing", topup: "Van top-up", kituse: "Van kit used", countshort: "Count short", countover: "Count over", reverse: "Correction" };
var REVERSIBLE = { receive: 1, topup: 1, extra: 1, "return": 1, scrap: 1, countshort: 1, countover: 1, adjust: 1 };
function placeName(l) { return !l ? "" : l === "WH" ? "Store" : l.indexOf("JOB:") === 0 ? l.slice(4) : l === "SUPPLIER" ? "Supplier" : l === "USED" ? "Used" : l === "LOSS" ? "Lost/found" : l === "SCRAP" ? "Scrap" : vanName(l); }
function canReverse(m) {
  if (!canManage() || !REVERSIBLE[m.type]) return false;
  if (D.Moves.some(function (x) { return x.type === "reverse" && x.ref === m.id; })) return false;
  if (m.job) { var j = X.jobs[m.job]; if (!j || j.status !== "out") return false; }
  return true;
}
function vItemHistory(sku) {
  var it = X.items[sku];
  var list = D.Moves.filter(function (m) { return m.sku === sku; }).slice(-150).reverse();
  var places = Object.keys(X.B).filter(function (l) { return C.isRealPlace(l) && Math.abs(bal(l, sku)) > 0.004; });
  var reversed = {}; D.Moves.forEach(function (m) { if (m.type === "reverse") reversed[m.ref] = true; });
  var pending = {}; Q.forEach(function (b) { b.ops.forEach(function (op) { (op.op === "append" ? op.rows : []).forEach(function (r) { pending[r.id] = true; }); }); });
  var rows = list.map(function (m) {
    var open = S.f.rev === m.id;
    return '<div class="hist"><div class="spread"><div><b>' + esc(MOVE_LABEL[m.type] || m.type) + "</b>" + (m.type === "reverse" ? ' <span class="tiny muted">of ' + esc(MOVE_LABEL[m.reverses] || m.reverses) + "</span>" : "") +
      (reversed[m.id] ? ' <span class="pill p-closed">Corrected</span>' : "") + (pending[m.id] ? ' <span class="pill p-kitted">Waiting to sync</span>' : "") +
      '<div class="tiny muted">' + esc(dtime(m.ts)) + (m.by ? " · " + esc(m.by) : "") + "</div></div>" +
      '<div class="right"><span class="mono">' + q(m.qty, sku) + '</span><span class="tiny muted">' + esc(placeName(m.from)) + " → " + esc(placeName(m.to)) + "</span></div></div>" +
      ((m.reason || m.ref || m.serial) ? '<div class="tiny muted">' + [m.serial ? "Serial " + esc(m.serial) : "", m.reason ? esc(m.reason) : "", m.ref && m.type !== "reverse" ? esc(m.ref) : ""].filter(Boolean).join(" · ") + "</div>" : "") +
      (canReverse(m) && !open ? '<button class="btn ghost small" data-action="revStart" data-id="' + esc(m.id) + '">Reverse this</button>' : "") +
      (open ? '<div class="panel" style="padding:10px"><p class="small">This records a correction that undoes the movement above. Nothing is deleted.</p>' +
        '<label class="f">Why? (required)<input id="rev_reason" data-bind="revReason" value="' + esc(S.f.revReason || "") + '" placeholder="e.g. Typed 100 instead of 10"></label>' +
        '<div class="row"><button class="btn small" data-action="revConfirm" data-id="' + esc(m.id) + '">Confirm correction</button><button class="btn ghost small" data-action="revCancel">Cancel</button></div></div>' : "") +
      "</div>";
  }).join("");
  return '<div class="row"><button class="btn ghost small" data-action="itemBack">← Stock</button></div>' +
    '<div><div class="eyebrow">' + esc(sku) + "</div><h2>" + esc(it.name) + '</h2><div class="small muted">Average landed cost (excl. VAT) ' + R(it.cost) + (isLen(it.uom) ? " per " + UNIT[it.uom].per : " each") + "</div></div>" +
    msgHtml() +
    '<section class="panel"><h3>Where it is now</h3>' + (places.length ? places.map(function (l) { return '<div class="spread"><span>' + esc(placeName(l)) + '</span><span class="mono">' + q(bal(l, sku), sku) + "</span></div>"; }).join("") : '<p class="muted small">None in stock.</p>') + "</section>" +
    '<section class="panel"><h3>Movements</h3><p class="tiny muted">Newest first. Movements are never edited or deleted; mistakes are reversed with a reason, so the record stays complete for an audit.</p>' +
    (rows || '<p class="muted">No movements yet.</p>') + "</section>";
}

/* ---------- Counts ---------- */
function countCells(place, sku) {
  var raw = (S.f.cnt || {})[sku], sys = bal(place, sku);
  if (raw === undefined || raw === "") return ["", ""];
  var diff = C.round2(n(raw) - sys);
  var target = n((X.kit.find(function (k) { return k.sku === sku; }) || {}).target);
  return [diff < 0 ? '<span class="pill p-bad">' + q(diff, sku) + "</span>" : diff > 0 ? "+" + q(diff, sku) : "✓", q(Math.max(0, target - n(raw)), sku)];
}
function patchCounts() {
  var place = S.f.place || "WH";
  var t = document.getElementById("cntTotal"); if (t) t.innerHTML = countTotal(place);
  Object.keys(S.f.cnt || {}).forEach(function (sku) {
    var cells = countCells(place, sku), a = document.getElementById("cdiff_" + sku), b = document.getElementById("ctop_" + sku);
    if (a) a.innerHTML = cells[0]; if (b) b.innerHTML = cells[1];
  });
}
function vCounts(inInv) {
  var place = S.f.place || "WH";
  var c = S.f.cnt || (S.f.cnt = {});
  var isVan = place !== "WH";
  var flt = String(S.f.cflt || "").trim().toLowerCase();
  var all = isVan ? X.kit.map(function (k) { return k.sku; }) : D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) { return i.sku; });
  var skus = all.filter(function (sku) { return !flt || (nameOf(sku) + " " + sku).toLowerCase().indexOf(flt) >= 0; });
  var last = null;
  D.Moves.forEach(function (m) { if ((m.type === "countshort" || m.type === "countover" || m.type === "kituse") && (m.from === place || m.to === place)) last = m.ts; });
  var pending = (D.Counts || []).filter(function (x) { return x.status === "pending" && x.place === place; });
  var direct = isVan || canManage();
  var rows = skus.map(function (sku) {
    var raw = c[sku];
    return "<tr><td>" + esc(nameOf(sku)) + '<div class="tiny muted mono">' + esc(sku) + '</div></td><td class="n">' + q(bal(place, sku), sku) + '</td><td class="n" style="min-width:90px"><input class="num" id="cnt_' + esc(sku) + '" type="number" inputmode="decimal" min="0" step="any" value="' + esc(raw == null ? "" : raw) +
      '" data-bind="cnt.' + esc(sku) + '" data-live="1" aria-label="Counted ' + esc(nameOf(sku)) + '"></td><td class="n" id="cdiff_' + esc(sku) + '">' + countCells(place, sku)[0] + "</td>" +
      (isVan ? '<td class="n" id="ctop_' + esc(sku) + '">' + countCells(place, sku)[1] + "</td>" : "") + "</tr>";
  }).join("");
  return (inInv ? "" : "<h2>Counts</h2>") + '<section class="panel"><label class="f">What are you counting?<select id="cnt_place" data-bind="place" data-rerender="1" data-reset="cnt">' +
    '<option value="WH"' + (place === "WH" ? " selected" : "") + ">Store shelves</option>" + X.vans.map(function (v) { return '<option value="' + esc(v.id) + '"' + (v.id === place ? " selected" : "") + ">" + esc(v.name) + " kit</option>"; }).join("") + "</select></label>" +
    '<p class="small muted">Last counted: ' + (last ? dshort(last) : "never") + ". " + (isVan ? "Count weekly. Shortfalls are booked as parts used on jobs; then top up to target." :
      direct ? "As a manager, your count changes stock straight away. Leave a line blank to skip it." : "Count cable and expensive items weekly, the rest monthly. Leave a line blank to skip it. A Warehouse Manager approves the count before stock changes.") + "</p>" +
    (pending.length && !isVan ? '<div class="msg warn">' + pending.length + " count(s) for the store are waiting for a manager to approve." + (isAdmin() ? "" : "") + "</div>" : "") +
    (all.length > 8 ? '<label class="f">Find an item<input id="cnt_flt" data-bind="cflt" data-rerender="1" value="' + esc(S.f.cflt || "") + '" placeholder="Type a name or code" autocomplete="off"></label>' : "") +
    (skus.length ? '<div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">System</th><th class="n">Counted</th><th class="n">Diff</th>' + (isVan ? '<th class="n">Top up</th>' : "") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" :
      '<p class="muted">' + (all.length ? "No items match." : isVan ? "No van kit list yet. An admin sets it up in Admin → Vans." : "No items yet.") + "</p>") +
    '<div id="cntTotal"></div>' +
    (!direct ? '<label class="f">Note for the admin (optional)<input id="cnt_note" data-bind="cnote" value="' + esc(S.f.cnote || "") + '" placeholder="e.g. Drum 2 label damaged, measured by hand"></label>' : "") +
    msgHtml() + '<button class="btn wide" data-action="saveCount"' + (S.busy || !all.length ? " disabled" : "") + ">" + (direct ? "Save count" : "Submit count for approval") + "</button></section>";
}
function countTotal(place) {
  var lines = C.countLines(place, S.f.cnt || {}, X.B, X.items);
  var short = 0, over = 0;
  lines.forEach(function (l) { if (l.value < 0) short += -l.value; else over += l.value; });
  if (!lines.length) return "";
  return '<p class="small">' + lines.length + " counted · <b>" + R(short) + "</b> short · <b>" + R(over) + "</b> over</p>";
}

/* ---------- More / Admin ---------- */
function tile(sub, title, desc, badge) {
  return '<button class="card" data-action="sub" data-sub="' + sub + '"><div><h3>' + title + '</h3><div class="small muted">' + desc + "</div></div>" +
    '<div class="right">' + (badge || "") + "<span aria-hidden=\"true\">›</span></div></button>";
}
function vMore() {
  var subs = { items: vItems, labels: vLabels, vans: vVans, account: vAccount, users: vUsers, reports: vReports, corrections: vCorrections, inventory: vInventory };
  var need = { users: isAdmin(), items: canManage(), vans: canManage(), corrections: canManage(), inventory: canManage(), reports: role() !== "storeman" };
  if (S.sub && subs[S.sub] && need[S.sub] !== false) return subs[S.sub]();
  if (canManage()) {
    var L = C.losses(D.Moves, 30);
    var users = S.users || [];
    var reversals = D.Moves.filter(function (m) { return m.type === "reverse"; }).length;
    var pending = (D.Counts || []).filter(function (x) { return x.status === "pending"; }).length;
    var low = D.Items.filter(function (it) { return n(it.reorder) > 0 && bal("WH", it.sku) < n(it.reorder); }).length;
    return "<h2>" + hubName() + '</h2><p class="small muted">Signed in as ' + esc(ROLE_LABEL[role()]) + ". Every change here is checked by the Google Sheet.</p><div class=\"list\">" +
      tile("inventory", "Inventory", "Approve counts, stock take, adjust, import and export",
        (pending ? '<span class="pill p-bad">' + pending + " to approve</span>" : "") + (low ? '<span class="pill p-kitted">' + low + " to order</span>" : "")) +
      tile("reports", "Missing stock report", "By installer, van and job; jobs over quote", L.total > 0 ? '<span class="pill p-bad">' + R(L.total) + " · 30 days</span>" : "") +
      tile("corrections", "Corrections log", "Every reversed movement, who and why", reversals ? '<span class="pill p-kitted">' + reversals + "</span>" : "") +
      tile("items", "Items", "Products, units, costs, reorder levels, cable allowance") +
      tile("vans", "Vans and van kit", "Vans and the small parts each one carries") +
      tile("labels", "Stickers", "Make and print QR stickers") +
      (isAdmin() ? tile("users", "Logins", "Who can sign in and what they can do", users.length ? '<span class="pill p-quoted">' + users.filter(function (u) { return u.active === "yes"; }).length + " active</span>" : "") : "") +
      tile("account", isAdmin() ? "My account and connection" : "My account", isAdmin() ? "Change PIN, sign out, Google Sheet link" : "Change PIN, sign out") + "</div>";
  }
  return "<h2>More</h2><div class=\"list\">" +
    tile("labels", "Stickers", canWork() ? "Make and print QR stickers for drums, bins and shelves" : "View and print stickers") +
    (role() === "viewer" ? tile("reports", "Missing stock report", "By installer, van and job; jobs over quote") : "") +
    tile("account", "My account", "Change PIN, sign out") + "</div>";
}

/* ---- Inventory (Warehouse Manager + Senior Admin) ---- */
var INV_TABS = { approve: "Approve", take: "Stock take", adjust: "Adjust", io: "Import / export" };
function vInventory() {
  var t = S.f.invTab || ((D.Counts || []).some(function (x) { return x.status === "pending"; }) ? "approve" : "take");
  var pending = (D.Counts || []).filter(function (x) { return x.status === "pending"; }).length;
  var tabs = '<div class="segs" role="tablist">' + Object.keys(INV_TABS).map(function (k) {
    return '<button class="seg' + (k === t ? " on" : "") + '" role="tab" aria-selected="' + (k === t) + '" data-action="invTab" data-t="' + k + '">' + INV_TABS[k] +
      (k === "approve" && pending ? ' <span class="badge">' + pending + "</span>" : "") + "</button>";
  }).join("") + "</div>";
  var body = t === "approve" ? vApprove() : t === "take" ? vCounts(true) : t === "adjust" ? vAdjust() : vImport();
  return backMore() + '<div class="spread"><h2>Inventory</h2><button class="btn ghost small" data-action="refreshAll"' + (S.busy ? " disabled" : "") + ">↻ Refresh from Sheet</button></div>" + tabs + (t === "take" ? "" : msgHtml()) + body;
}

function money2(v) { var x = Math.round(n(v) * 100) / 100; return (x < 0 ? "\u2212R\u00a0" : "R\u00a0") + Math.abs(x).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// An earlier receipt with the same reference (supplier + invoice number), ignoring case and spaces.
function findReceipt(ref) {
  var k = String(ref || "").replace(/\s+/g, "").toLowerCase();
  if (!k) return null;
  return D.Moves.find(function (m) { return m.type === "receive" && String(m.ref || "").replace(/\s+/g, "").toLowerCase() === k; }) || null;
}
function countLinesOf(c) { try { return JSON.parse(c.lines || "[]"); } catch (e) { return []; } }
function vApprove() {
  var list = (D.Counts || []).slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  var pend = list.filter(function (c) { return c.status === "pending"; });
  var done = list.filter(function (c) { return c.status !== "pending"; }).slice(0, 10);
  function linesTable(c) {
    var lines = countLinesOf(c);
    return '<div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">System</th><th class="n">Counted</th><th class="n">Diff</th><th class="n">Value</th></tr></thead><tbody>' +
      lines.map(function (l) {
        return "<tr><td>" + esc(nameOf(l.sku)) + '</td><td class="n">' + q(l.system, l.sku) + '</td><td class="n">' + q(l.counted, l.sku) + '</td><td class="n">' +
          (l.diff < 0 ? '<span class="pill p-bad">' + q(l.diff, l.sku) + "</span>" : l.diff > 0 ? "+" + q(l.diff, l.sku) : "✓") + '</td><td class="n">' + (l.diff ? R(l.value) : "") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  var me = cfg.user && cfg.user.username;
  var html = pend.length ? pend.map(function (c) {
    var lines = countLinesOf(c), diffs = lines.filter(function (l) { return l.diff; }).length;
    var own = c.by === me, open = S.f.rejecting === c.id;
    return '<section class="panel"><div class="spread"><div><h3>' + (c.place === "WH" ? "Store shelves" : esc(vanName(c.place))) + '</h3><div class="tiny muted">Counted by <b>' + esc(c.by) + "</b> · " + esc(dtime(c.ts)) +
      " · " + lines.length + (lines.length === 1 ? " line, " : " lines, ") + diffs + " different</div></div>" + '<span class="pill ' + (n(c.value) < 0 ? "p-bad" : "p-closed") + '">' + R(c.value) + "</span></div>" +
      (c.note ? '<div class="small">Note: ' + esc(c.note) + "</div>" : "") + linesTable(c) +
      '<p class="tiny muted">Approving books the differences shown, as they were when counted. Stock that moved since then is not affected.</p>' +
      (own ? '<div class="msg info">This is your own count. Another Warehouse Manager or the Senior Admin must approve it.</div>' :
        open ? '<label class="f">Why reject it? (required)<input id="rej_' + esc(c.id) + '" data-bind="rejNote" value="' + esc(S.f.rejNote || "") + '" placeholder="e.g. Drum 2 missed, please recount"></label>' +
          '<div class="row"><button class="btn" data-action="rejectCount" data-id="' + esc(c.id) + '">Reject count</button><button class="btn ghost" data-action="rejCancel">Cancel</button></div>' :
        '<div class="row"><button class="btn" data-action="approveCount" data-id="' + esc(c.id) + '"' + (S.busy ? " disabled" : "") + ">Approve</button>" +
          '<button class="btn ghost" data-action="rejStart" data-id="' + esc(c.id) + '">Reject</button></div>') + "</section>";
  }).join("") : '<section class="panel"><p class="muted">No counts waiting. When a User counts the store shelves, it appears here for approval.</p></section>';
  if (done.length) html += '<section class="panel"><h3>Recent decisions</h3>' + done.map(function (c) {
    return '<div class="hist"><div class="spread"><div><b>' + (c.place === "WH" ? "Store shelves" : esc(vanName(c.place))) + '</b><div class="tiny muted">Counted by ' + esc(c.by) + " · " + esc(dshort(c.ts)) +
      " · " + (c.status === "approved" ? "approved" : "rejected") + " by " + esc(c.decidedBy || "") + "</div></div>" +
      '<span class="pill ' + (c.status === "approved" ? "p-closed" : "p-bad") + '">' + (c.status === "approved" ? "Approved" : "Rejected") + "</span></div>" +
      (c.status === "rejected" && c.decisionNote ? '<div class="tiny">Reason: ' + esc(c.decisionNote) + "</div>" : "") + "</div>";
  }).join("") + "</section>";
  return html;
}

var ADJ_REASONS = ["Damaged / written off", "Found", "Count correction", "Supplier short-delivered", "Other"];
function vAdjust() {
  var f = S.f.adj || (S.f.adj = { dir: "remove", place: "WH", reason: ADJ_REASONS[0] });
  var it = X.items[f.sku];
  var places = '<option value="WH"' + (f.place === "WH" ? " selected" : "") + ">Store</option>" + X.vans.map(function (v) { return '<option value="' + esc(v.id) + '"' + (v.id === f.place ? " selected" : "") + ">" + esc(v.name) + "</option>"; }).join("");
  var value = it ? n(f.qty) * cost(f.sku) : 0;
  return '<section class="panel"><h3>Adjust one item</h3><p class="small muted">For damage, finds and fixing a known mistake. The reason is saved with the movement and shows in the item history.</p>' +
    '<div class="row"><label class="f" style="flex:2 1 200px">Item<select id="adj_sku" data-bind="adj.sku"><option value="">Choose…</option>' + D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) { return '<option value="' + esc(i.sku) + '"' + (i.sku === f.sku ? " selected" : "") + ">" + esc(i.name) + "</option>"; }).join("") + "</select></label>" +
    '<label class="f">Where<select id="adj_place" data-bind="adj.place">' + places + "</select></label></div>" +
    (it ? '<p class="small">Now in ' + esc(f.place === "WH" ? "store" : vanName(f.place)) + ': <b class="mono">' + q(bal(f.place, f.sku), f.sku) + "</b></p>" : "") +
    '<div class="row" role="radiogroup" aria-label="Add or remove"><button class="btn small ' + (f.dir === "remove" ? "" : "ghost") + '" role="radio" aria-checked="' + (f.dir === "remove") + '" data-action="adjDir" data-d="remove">− Remove</button>' +
    '<button class="btn small ' + (f.dir === "add" ? "" : "ghost") + '" role="radio" aria-checked="' + (f.dir === "add") + '" data-action="adjDir" data-d="add">+ Add</button></div>' +
    '<div class="row"><label class="f">Quantity' + (it ? unitHint(it.sku) : "") + '<input class="num" id="adj_qty" type="number" inputmode="decimal" min="0" step="any" data-bind="adj.qty" value="' + esc(f.qty || "") + '"></label>' +
    '<label class="f" style="flex:2 1 200px">Reason<select id="adj_reason" data-bind="adj.reason">' + ADJ_REASONS.map(function (r) { return "<option" + (r === f.reason ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select></label></div>" +
    '<label class="f">Details (required)<input id="adj_note" data-bind="adj.note" value="' + esc(f.note || "") + '" placeholder="e.g. 6 m crushed by forklift, binned"></label>' +
    (it && n(f.qty) > 0 ? '<p class="small">This ' + (f.dir === "remove" ? "removes" : "adds") + " <b>" + q(f.qty, f.sku) + "</b> worth <b>" + R(value) + "</b>." + (f.dir === "remove" ? " It counts as missing stock in the report." : "") + "</p>" : "") +
    msgHtml() + '<button class="btn wide" data-action="saveAdjust"' + (S.busy ? " disabled" : "") + ">Save adjustment</button></section>";
}

function vImport() {
  var f = S.f.imp || (S.f.imp = { mode: "set", text: "" });
  var prev = f.preview;
  var table = "", total = 0;
  var recv = f.mode === "receive";
  var dup = recv ? findReceipt(f.ref) : null;
  if (prev) {
    table = (prev.errors.length ? '<div class="msg err">' + prev.errors.map(esc).join("<br>") + "</div>" : "") +
      (prev.rows.length ? '<div class="tablewrap"><table class="sumt"><thead><tr><th>Item</th>' + (recv ? '<th class="n">Qty</th><th class="n">Cost each</th>' : '<th class="n">In store</th><th class="n">Counted</th><th class="n">Change</th>') + '<th class="n">Value</th></tr></thead><tbody>' +
        prev.rows.map(function (r) {
          var sys = r.isNew ? 0 : bal("WH", r.sku), chg = recv ? r.qty : C.round2(r.qty - sys);
          var c = r.cost != null ? r.cost : cost(r.sku);
          total += chg * c;
          return "<tr><td>" + esc(r.isNew ? r.name : nameOf(r.sku)) + '<div class="tiny muted"><span class="mono">' + esc(r.sku) + "</span>" + (r.isNew ? ' · <span class="pill p-quoted">New, ' + UNIT[r.uom || "ea"].long + "</span>" : "") + (r.vatRemoved ? ' · <span class="pill p-kitted">VAT removed</span>' : "") + "</div></td>" +
            (recv ? '<td class="n">' + r.qty + (r.uom && r.uom !== "ea" ? "\u00a0" + UNIT[r.uom].short : "") + '</td><td class="n">' + money2(c) + "</td>" :
              '<td class="n">' + (r.isNew ? "–" : q(sys, r.sku)) + '</td><td class="n">' + r.qty + '</td><td class="n">' + (chg < 0 ? '<span class="pill p-bad">' + chg + "</span>" : chg > 0 ? "+" + chg : "✓") + "</td>") +
            '<td class="n">' + money2(chg * c) + "</td></tr>";
        }).join("") + '</tbody><tfoot><tr><td colspan="' + (recv ? 3 : 4) + '"><b>Total value</b></td><td class="n"><b>' + money2(total) + "</b></td></tr></tfoot></table></div>" +
        '<p class="tiny muted">Check the total against the invoice subtotal (excl. VAT) before applying. A difference of a cent or two is supplier rounding.</p>' : "") +
      (dup ? '<div class="msg err"><b>' + esc(f.ref) + "</b> was already received on " + esc(dtime(dup.ts)) + " by " + esc(dup.by || "someone") + ". Receiving it again doubles the stock." +
        '<label class="chk"><input type="checkbox" id="imp_dupok" data-bind="imp.dupOk" data-check="1"' + (f.dupOk ? " checked" : "") + "> This is a separate delivery with the same reference. Receive it again.</label></div>" : "") +
      (prev.rows.length && !prev.errors.length ? '<button class="btn wide" data-action="applyImport"' + (S.busy || (dup && !f.dupOk) ? " disabled" : "") + ">Apply " + prev.rows.length + " line(s)</button>" : "") +
      (prev.errors.length && prev.rows.length ? '<p class="tiny muted">Fix the lines above, then preview again. Nothing is changed until every line is valid.</p>' : "");
  }
  return '<section class="panel"><h3>Export</h3><p class="small muted">Download every item with its store quantity and landed cost. Open it in Excel, update the quantities, and paste it back below.</p>' +
    '<button class="btn ghost" data-action="exportStock">Download stock list (CSV)</button></section>' +
    '<section class="panel"><h3>Import from Excel</h3>' +
    '<div class="row" role="radiogroup" aria-label="What the numbers mean">' +
    '<button class="btn small ' + (f.mode === "set" ? "" : "ghost") + '" role="radio" aria-checked="' + (f.mode === "set") + '" data-action="impMode" data-m="set">Set store stock to these counts</button>' +
    '<button class="btn small ' + (f.mode === "receive" ? "" : "ghost") + '" role="radio" aria-checked="' + (f.mode === "receive") + '" data-action="impMode" data-m="receive">Add as received (opening stock / delivery)</button></div>' +
    '<p class="small muted">' + (f.mode === "set" ? "Use for a full stock take done on paper or in Excel. The store quantity becomes the number you give; differences are booked as count adjustments. A cost column, if given, updates the item's landed cost." :
      "Use for day-one opening stock or a big delivery. The quantities are added to the store at the landed cost you give (moving average).") + "</p>" +
    '<p class="tiny muted">Paste from Excel or a supplier invoice <b>with a header row</b> and the columns are found by name: <b>Item code, Quantity</b>, Description, Unit price or Total (excl. VAT), Unit (m or ea). If there\'s a line total, cost = total ÷ quantity, so it matches the invoice to the cent. Without a header, the order is: code, quantity, cost, name, unit.</p>' +
    '<p class="tiny muted">Supplier codes with spaces or slashes are fine: <span class="mono">ABC BOX 4X4</span> is stored as <span class="mono">ABC-BOX-4X4</span>. New items are created automatically. Stock is costed <b>excluding VAT</b> (VAT-registered, 15%). If your price or total column is labelled <i>incl VAT</i>, the 15% is taken off automatically and marked in the preview. Units: <b>m</b> metres (default for lengths), <b>in</b> inches, <b>ea</b> units.</p>' +
    '<div class="row"><label class="btn ghost small filebtn">Choose file (CSV or text)<input type="file" id="imp_file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden></label>' +
    '<span class="tiny muted">or paste the lines below</span></div>' +
    '<label class="f">Paste here<textarea id="imp_text" rows="7" class="mono" data-bind="imp.text" placeholder="PV6-RED&#9;450&#9;18.90&#10;MC4&#9;120&#9;28&#10;BRK-32A&#9;12&#9;95&#9;Breaker 32 A&#9;ea">' + esc(f.text || "") + "</textarea></label>" +
    (f.mode === "receive" ? '<label class="f">Supplier and invoice number (required)<input id="imp_ref" data-bind="imp.ref" value="' + esc(f.ref || "") + '" placeholder="e.g. Supplier name INV123456, or Opening stock 1 Dec 2026"></label>' : "") +
    '<button class="btn ghost" data-action="previewImport">Preview</button>' + table + "</section>";
}

function backMore() { return '<div class="row"><button class="btn ghost small" data-action="sub" data-sub="">← ' + hubName() + "</button></div>"; }

function vItems() {
  var f = S.f.it || (S.f.it = { uom: "m", track: "qty", allowancePct: "10" });
  var list = D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) {
    return '<button class="card" data-action="editItem" data-sku="' + esc(i.sku) + '"><div><div>' + esc(i.name) + '</div><div class="tiny muted mono">' + esc(i.sku) + " · " + UNIT[unitOfSku(i.sku)].long + (i.track === "serial" ? " · serial" : "") + '</div></div><span class="mono small">' + R(i.cost) + (isLen(i.uom) ? "/" + UNIT[i.uom].short : "") + "</span></button>";
  }).join("");
  return backMore() + "<h2>Items</h2>" +
    '<section class="panel"><h3>' + (f.editing ? "Edit " + esc(f.sku) : "Add an item") + '</h3><div class="row">' +
    '<label class="f">Item code<input class="code" id="it_sku" data-bind="it.sku" value="' + esc(f.sku || "") + '"' + (f.editing ? " readonly" : "") + ' placeholder="PV6-RED"></label>' +
    '<label class="f" style="flex:2 1 200px">Description<input id="it_name" data-bind="it.name" value="' + esc(f.name || "") + '" placeholder="PV cable 6 mm² red"></label></div><div class="row">' +
    '<label class="f">Measured in<select id="it_uom" data-bind="it.uom">' + [["m", "Metres (length)"], ["in", "Inches (length)"], ["ea", "Units (count)"]].map(function (o) { return '<option value="' + o[0] + '"' + ((f.uom || "m") === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select></label>" +
    '<label class="f">Tracked by<select id="it_track" data-bind="it.track"><option value="qty">Quantity</option><option value="serial"' + (f.track === "serial" ? " selected" : "") + ">Serial number</option></select></label>" +
    '<label class="f">Order when store has less than<input class="num" id="it_reorder" type="number" min="0" data-bind="it.reorder" value="' + esc(f.reorder || "") + '"></label>' +
    '<label class="f">Cable allowance %<input class="num" id="it_allow" type="number" min="0" data-bind="it.allowancePct" value="' + esc(f.allowancePct == null ? "" : f.allowancePct) + '"></label></div>' +
    msgHtml() + '<div class="row"><button class="btn" data-action="saveItem"' + (S.busy ? " disabled" : "") + ">" + (f.editing ? "Save" : "Add item") + "</button>" + (f.editing ? '<button class="btn ghost" data-action="sub" data-sub="items">Cancel</button>' : "") + "</div>" +
    '<p class="tiny muted">Cost is set automatically from the landed cost when stock is received.</p></section><div class="list">' + list + "</div>";
}

function vLabels() {
  var f = S.f.lb || (S.f.lb = {});
  var cards = D.Labels.slice().sort(function (a, b) { return a.code.localeCompare(b.code); }).map(function (l) {
    return '<div class="lbl"><img src="' + qrImg(labelLink(l.code), 4) + '" alt="QR ' + esc(l.code) + '"><div class="id">' + esc(l.code) + "</div><div>" + esc(nameOf(l.sku)) + '</div><div class="tiny muted">' + esc(l.note) + "</div></div>";
  }).join("");
  return backMore() + '<div class="spread"><h2>Stickers</h2><button class="btn ghost small" data-action="printLabels"' + (D.Labels.length ? "" : " disabled") + ">Print sticker sheet</button></div>" +
    (canWork() ? '<section class="panel"><h3>New sticker</h3><p class="small muted">One sticker per drum, roll, box or shelf bin. Panels and inverters use their factory serial barcode instead.</p><div class="row">' +
    '<label class="f">Item<select id="lb_sku" data-bind="lb.sku"><option value="">Choose…</option>' + D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) { return '<option value="' + esc(i.sku) + '"' + (i.sku === f.sku ? " selected" : "") + ">" + esc(i.name) + "</option>"; }).join("") + "</select></label>" +
    '<label class="f">Where it goes<input id="lb_note" data-bind="lb.note" value="' + esc(f.note || "") + '" placeholder="e.g. Drum 3 · 500 m"></label></div>' +
    msgHtml() + '<button class="btn" data-action="saveLabel"' + (S.busy ? " disabled" : "") + ">Create sticker</button></section>" : msgHtml()) +
    '<div class="labels">' + (cards || '<p class="muted">No stickers yet.</p>') + "</div>" +
    '<p class="tiny muted">Each sticker holds a link. Pointing the normal phone camera at it opens this app on that item.</p>';
}

function vVans() {
  var f = S.f.vn || (S.f.vn = {});
  var kitT = S.f.kt || (S.f.kt = {});
  D.VanKit.forEach(function (k) { if (kitT[k.sku] === undefined) kitT[k.sku] = String(k.target); });
  var rows = D.Items.filter(function (i) { return !isLen(i.uom) && i.track !== "serial"; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) {
    return "<tr><td>" + esc(i.name) + '</td><td class="n" style="min-width:90px"><input class="num" id="kt_' + esc(i.sku) + '" type="number" min="0" data-bind="kt.' + esc(i.sku) + '" value="' + esc(kitT[i.sku] || "") + '" aria-label="Van target ' + esc(i.name) + '"></td></tr>';
  }).join("");
  return backMore() + "<h2>Vans</h2>" + msgHtml() +
    '<section class="panel"><h3>Vans</h3>' + X.vans.map(function (v) { return '<div class="spread"><span>' + esc(v.name) + '</span><span class="mono tiny muted">' + esc(v.id) + "</span></div>"; }).join("") +
    '<div class="row"><label class="f">New van name<input id="vn_name" data-bind="vn.name" value="' + esc(f.name || "") + '" placeholder="e.g. Van 3 · Ranger CA 123-456"></label><button class="btn ghost" data-action="saveVan">Add van</button></div></section>' +
    '<section class="panel"><h3>Van kit (same for every van)</h3><p class="small muted">Small parts only. Cable and big items always go out per job. Leave blank to keep an item off the van.</p>' +
    '<div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">Keep in van</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    '<button class="btn" data-action="saveKit"' + (S.busy ? " disabled" : "") + ">Save van kit</button></section>";
}

/* ---- Logins (admin) ---- */
function vUsers() {
  var users = (S.users || []).slice().sort(function (a, b) { return (a.active === b.active ? 0 : a.active === "yes" ? -1 : 1) || a.name.localeCompare(b.name); });
  var f = S.f.us || (S.f.us = { isNew: true, role: "storeman", active: "yes", pin: suggestPin(4) });
  var temp = S.f.tempPin;
  var list = users.map(function (u) {
    return '<button class="card" data-action="editUser" data-u="' + esc(u.username) + '"><div><div>' + esc(u.name) + '</div><div class="tiny muted"><span class="mono">' + esc(u.username) + "</span> · last sign-in " + (u.lastLogin ? esc(dshort(u.lastLogin)) : "never") + "</div></div>" +
      '<div class="right"><span class="pill ' + (u.role === "admin" ? "p-out" : u.role === "manager" ? "p-closed" : u.role === "storeman" ? "p-quoted" : "p-kitted") + '">' + ROLE_LABEL[u.role] + "</span>" +
      (u.active !== "yes" ? '<span class="pill p-bad">Switched off</span>' : u.mustChange === "yes" ? '<span class="tiny muted">PIN not chosen yet</span>' : "") + "</div></button>";
  }).join("");
  var roleOpts = ["storeman", "manager", "admin", "viewer"].map(function (r) { return '<option value="' + r + '"' + (f.role === r ? " selected" : "") + ">" + ROLE_LABEL[r] + "</option>"; }).join("");
  var editingSelf = !f.isNew && cfg.user && f.username === cfg.user.username;
  return backMore() + "<h2>Logins</h2>" +
    (temp ? '<div class="msg ok"><b>Temporary PIN for ' + esc(temp.name) + ': <span class="mono" style="font-size:1.3em">' + esc(temp.pin) + "</span></b><br>Give it to them in person. They'll choose their own PIN when they first sign in. It won't be shown again.</div>" : "") +
    '<section class="panel"><h3>' + (f.isNew ? "Add a login" : "Edit " + esc(f.name)) + '</h3><div class="row">' +
    '<label class="f">Full name<input id="us_name" data-bind="us.name" value="' + esc(f.name || "") + '" placeholder="e.g. Sipho Mokoena"></label>' +
    '<label class="f">Username<input id="us_user" class="mono" autocapitalize="off" autocomplete="off" data-bind="us.username" value="' + esc(f.username || "") + '"' + (f.isNew ? "" : " readonly") + ' placeholder="e.g. sipho"></label></div><div class="row">' +
    '<label class="f">Role<select id="us_role" data-bind="us.role"' + (editingSelf ? " disabled" : "") + ">" + roleOpts + "</select></label>" +
    (f.isNew || (isMgrRole(f.role) && !isMgrRole(f.origRole)) ? '<label class="f">Temporary PIN<input id="us_pin" class="num" inputmode="numeric" data-bind="us.pin" value="' + esc(f.pin || "") + '"></label>' : "") +
    (!f.isNew ? '<label class="f">Status<select id="us_active" data-bind="us.active"' + (editingSelf ? " disabled" : "") + '><option value="yes"' + (f.active !== "no" ? " selected" : "") + '>Can sign in</option><option value="no"' + (f.active === "no" ? " selected" : "") + ">Switched off</option></select></label>" : "") +
    "</div>" +
    '<div class="roles tiny"><div><b>User</b> Daily stock work: jobs, kitting, scanning, receiving, returns. Shelf counts go to a manager for approval.</div>' +
    "<div><b>Warehouse Manager</b> Everything a User does, plus Inventory (approve counts, stock take, adjust, import), items and costs, van kits, corrections, reports.</div>" +
    "<div><b>Senior Admin</b> Everything, including logins and the Google Sheet connection.</div>" +
    "<div><b>Viewer</b> Looks at jobs, stock and reports. Can't change anything.</div></div>" +
    '<p class="tiny muted">Warehouse Managers and Senior Admins need a 6-digit PIN.</p>' +
    msgHtml() + '<div class="row"><button class="btn" data-action="saveUser"' + (S.busy ? " disabled" : "") + ">" + (f.isNew ? "Add login" : "Save") + "</button>" +
    (!f.isNew ? '<button class="btn ghost" data-action="resetUserPin"' + (S.busy ? " disabled" : "") + '>Reset PIN</button><button class="btn ghost" data-action="newUser">Cancel</button>' : "") + "</div>" +
    (!f.isNew ? '<p class="tiny muted">Switching someone off, changing their role or resetting their PIN signs them out on every device straight away.</p>' : "") + "</section>" +
    '<div class="list">' + (list || '<p class="muted">Loading logins…</p>') + "</div>";
}

/* ---- Reports (admin + viewer) ---- */
function vReports() {
  var days = n(S.f.days) || 30;
  var L = C.losses(D.Moves, days);
  function ranked(o, nm) {
    var e = Object.keys(o).map(function (k) { return [k, o[k]]; }).filter(function (x) { return Math.abs(x[1]) > 0.004; }).sort(function (a, b) { return b[1] - a[1]; });
    return e.length ? e.map(function (x) { return "<tr><td>" + esc(nm(x[0])) + '</td><td class="n">' + R(x[1]) + "</td></tr>"; }).join("") : '<tr><td class="muted">Nothing missing</td><td></td></tr>';
  }
  var since = Date.now() - days * 864e5;
  var closed = D.Jobs.filter(function (j) { return j.status === "closed" && new Date(j.closedAt).getTime() >= since; });
  var missJobs = closed.filter(function (j) { return n(j.missingValue) > 0; }).sort(function (a, b) { return n(b.missingValue) - n(a.missingValue); });
  var overJobs = closed.map(function (j) { return { j: j, f: C.overQuote(C.jobSummary(j.no, D.Lines, D.Moves, X.items), 10) }; }).filter(function (x) { return x.f.length; });
  var opts = [30, 90, 365].map(function (d) { return '<option value="' + d + '"' + (d === days ? " selected" : "") + ">Last " + d + " days</option>"; }).join("");
  return backMore() + '<div class="spread"><h2>Missing stock</h2><select id="rp_days" data-bind="days" style="width:auto">' + opts + "</select></div>" +
    '<div class="kpis"><div class="kpi"><div class="l">Missing</div><div class="v ' + (L.total > 0 ? "bad" : "") + '">' + R(L.total) + '</div></div>' +
    '<div class="kpi"><div class="l">Jobs closed</div><div class="v">' + closed.length + '</div></div><div class="kpi"><div class="l">Jobs with missing stock</div><div class="v">' + missJobs.length + "</div></div>" +
    '<div class="kpi"><div class="l">Jobs over quote</div><div class="v">' + overJobs.length + "</div></div></div>" +
    '<section class="panel"><h3>Where it sits</h3><div class="row" style="align-items:flex-start">' +
    '<div class="tablewrap" style="flex:1 1 220px"><table><thead><tr><th>Installer</th><th class="n">Value</th></tr></thead><tbody>' + ranked(L.byInstaller, function (x) { return x; }) + "</tbody></table></div>" +
    '<div class="tablewrap" style="flex:1 1 220px"><table><thead><tr><th>Van / place</th><th class="n">Value</th></tr></thead><tbody>' + ranked(L.byVan, vanName) + "</tbody></table></div></div>" +
    '<p class="tiny muted">One bad job is noise. The same name at the top month after month is a pattern worth a conversation.</p></section>' +
    (missJobs.length ? '<section class="panel"><h3>Jobs closed with missing stock</h3><div class="list">' + missJobs.map(function (j) {
      return '<button class="card" data-action="openJobFrom" data-job="' + esc(j.no) + '"><div><div><span class="no">' + esc(j.no) + "</span> · " + esc(j.client) + '</div><div class="tiny muted">' + esc(j.installer) + " · " + esc(vanName(j.van)) + " · " + esc(j.reason || "no reason") + '</div></div><span class="pill p-bad">' + R(j.missingValue) + "</span></button>";
    }).join("") + "</div></section>" : "") +
    (overJobs.length ? '<section class="panel"><h3>Jobs that used more than quoted</h3><div class="tablewrap"><table><thead><tr><th>Job</th><th>Item</th><th class="n">Over</th></tr></thead><tbody>' +
      overJobs.map(function (x) { return x.f.map(function (f) { return "<tr><td>" + esc(x.j.no) + '<div class="tiny muted">' + esc(x.j.type) + "</div></td><td>" + esc(nameOf(f.sku)) + '</td><td class="n">+' + Math.round(f.overPct) + "%</td></tr>"; }).join(""); }).join("") +
      '</tbody></table></div><p class="tiny muted">If the same job type keeps going over, the quote template is too low and the business is losing margin.</p></section>' : "");
}

/* ---- Corrections log (admin) ---- */
function vCorrections() {
  var list = D.Moves.filter(function (m) { return m.type === "reverse"; }).slice().reverse();
  return backMore() + "<h2>Corrections log</h2><p class=\"small muted\">Every movement that was reversed, by whom and why. Corrections are only possible for admins, from an item's history in Stock.</p>" +
    '<section class="panel">' + (list.length ? list.map(function (m) {
      return '<div class="hist"><div class="spread"><div><b>' + esc(nameOf(m.sku)) + '</b><div class="tiny muted">Undid: ' + esc(MOVE_LABEL[m.reverses] || m.reverses) + (m.job ? " · job " + esc(m.job) : "") + "</div></div>" +
        '<div class="right"><span class="mono">' + q(m.qty, m.sku) + '</span><span class="tiny muted">' + esc(dtime(m.ts)) + " · " + esc(m.by || "") + "</span></div></div>" +
        '<div class="small">Reason: ' + esc(m.reason || "—") + "</div></div>";
    }).join("") : '<p class="muted">No corrections yet.</p>') + "</section>";
}

/* ---- My account ---- */
function vAccount() {
  var f = S.f.ac || (S.f.ac = { url: cfg.url, site: cfg.site });
  var u = cfg.user || {};
  return backMore() + "<h2>My account</h2>" + msgHtml() +
    '<section class="panel"><div class="spread"><div><h3>' + esc(u.name) + '</h3><div class="small muted"><span class="mono">' + esc(u.username) + "</span> · " + ROLE_LABEL[u.role] + "</div></div>" +
    '<button class="btn ghost small" data-action="logout">Sign out</button></div>' +
    (S.f.confirmLogout ? '<div class="msg warn">' + Q.length + " change(s) haven't reached the Sheet yet. They'll be sent next time <b>you</b> sign in on this phone. Tap Sign out again to continue.</div>" : "") + "</section>" +
    '<section class="panel"><h3>Change my PIN</h3><div class="row">' +
    '<label class="f">Current PIN<input id="ac_old" type="password" inputmode="numeric" autocomplete="current-password" data-bind="ac.old"></label>' +
    '<label class="f">New PIN<input id="ac_new" type="password" inputmode="numeric" autocomplete="new-password" data-bind="ac.new1"></label>' +
    '<label class="f">New PIN again<input id="ac_new2" type="password" inputmode="numeric" autocomplete="new-password" data-bind="ac.new2"></label></div>' +
    '<button class="btn" data-action="changePin"' + (S.busy ? " disabled" : "") + ">Change PIN</button></section>" +
    '<section class="panel"><h3>Sync</h3><p class="small">' + (Q.length ? Q.length + " change(s) saved on this phone, waiting for signal." : "Everything is saved to the " + (cfg.mode === "live" ? "Google Sheet." : "demo data.")) + "</p>" +
    (Q.length ? '<button class="btn ghost small" data-action="syncNow">Try to sync now</button>' : "") + '<p class="tiny muted">App version ' + APP_VERSION + " · " + (cfg.mode === "live" ? "Google Sheet" : "Demo data on this phone") + "</p></section>" +
    (isAdmin() ? '<section class="panel"><h3>Connection (admin)</h3>' +
      '<label class="f">Google Sheet web app link<input id="ac_url" data-bind="ac.url" value="' + esc(f.url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
      '<label class="f">This app\'s web address (for stickers)<input id="ac_site" data-bind="ac.site" value="' + esc(f.site || "") + '" placeholder="' + esc(location.origin + location.pathname) + '"></label>' +
      '<button class="btn ghost" data-action="saveConnection">Save connection</button><p class="tiny muted">Changing the Sheet link signs you out, so you can sign in to the new Sheet.</p></section>' : "") +
    (cfg.mode === "demo" ? '<section class="panel"><h3>Data on this phone</h3>' +
      '<p class="small muted">' + (demoKind() === "empty" ? "You're using your own test data, kept only on this phone." : "You're using made-up example data.") + "</p>" +
      (isAdmin() ? '<div class="row"><button class="btn ghost" data-action="emptyDemo">' + (S.f.confirmEmpty ? "Tap again: delete all stock, items, jobs, stickers and counts" : "Start empty") + "</button>" +
        '<button class="btn ghost" data-action="resetDemo">Load example data</button></div>' +
        '<p class="tiny muted"><b>Start empty</b> deletes all stock, items, jobs, stickers and counts on this phone. Logins and vans are kept. Then add your stock under Inventory → Import / export.</p>' : "") +
      '<button class="btn ghost" data-action="goLive">Connect our Google Sheet</button></section>' : "");
}

/* ---- Sign in ---- */
function vLogin() {
  var f = S.f.lg || (S.f.lg = { url: cfg.url || "" });
  var needUrl = cfg.mode === "live" && !cfg.url;
  return '<section class="panel login"><div class="eyebrow">' + (cfg.mode === "demo" ? "Demo" : "Stock Counter") + "</div><h2>Sign in</h2>" +
    (S.loginMsg ? '<div class="msg info">' + esc(S.loginMsg) + "</div>" : "") +
    (needUrl ? '<label class="f">Google Sheet web app link<input id="lg_url" data-bind="lg.url" value="' + esc(f.url) + '" placeholder="https://script.google.com/macros/s/…/exec"></label><p class="tiny muted">From Part B of the setup guide. Only needed once on this device.</p>' : "") +
    '<label class="f">Username<input id="lg_user" autocapitalize="off" autocomplete="username" spellcheck="false" data-bind="lg.username" value="' + esc(f.username || "") + '"></label>' +
    '<label class="f">PIN<input id="lg_pin" type="password" inputmode="numeric" autocomplete="current-password" data-bind="lg.pin" value="' + esc(f.pin || "") + '"></label>' +
    msgHtml() + '<button class="btn wide" data-action="login"' + (S.busy ? " disabled" : "") + ">Sign in</button>" +
    (Q.length && Q[0].user ? '<p class="tiny muted">' + Q.length + " change(s) from <b>" + esc(Q[0].user) + "</b> are waiting on this phone. They'll sync when " + esc(Q[0].user) + " signs in.</p>" : "") +
    (cfg.mode === "demo" ? '<div class="msg info small">Demo logins (any of these):<br><span class="mono">admin</span> PIN <span class="mono">246810</span> (Senior Admin)<br><span class="mono">lebo</span> PIN <span class="mono">580214</span> (Warehouse Manager)<br><span class="mono">sipho</span> PIN <span class="mono">1357</span> (User)<br><span class="mono">owner</span> PIN <span class="mono">8642</span> (Viewer)</div>' : "") +
    '<button class="linkbtn small muted" data-action="' + (cfg.mode === "demo" ? "goLive" : "useDemo") + '">' + (cfg.mode === "demo" ? "Connect our Google Sheet instead" : "Try the demo instead") + "</button>" +
    (needUrl ? "" : (cfg.mode === "live" ? '<button class="linkbtn small muted" data-action="changeUrl">Use a different Google Sheet</button>' : "")) +
    "</section>";
}
function vChangePinFirst() {
  var f = S.f.cp || (S.f.cp = {});
  return '<section class="panel login"><div class="eyebrow">Welcome, ' + esc(cfg.user.name) + "</div><h2>Choose your PIN</h2>" +
    '<p class="small">You signed in with a temporary PIN. Choose your own now. Only you should know it.' + (isAdmin() ? " Managers and admins need 6 to 8 digits." : " Use 4 to 8 digits.") + "</p>" +
    '<label class="f">Temporary PIN<input id="cp_old" type="password" inputmode="numeric" autocomplete="current-password" data-bind="cp.old"></label>' +
    '<label class="f">New PIN<input id="cp_new" type="password" inputmode="numeric" autocomplete="new-password" data-bind="cp.new1"></label>' +
    '<label class="f">New PIN again<input id="cp_new2" type="password" inputmode="numeric" autocomplete="new-password" data-bind="cp.new2"></label>' +
    msgHtml() + '<button class="btn wide" data-action="firstPin"' + (S.busy ? " disabled" : "") + ">Save my PIN</button>" +
    '<button class="linkbtn small muted" data-action="logout">Sign out</button></section>';
}

/* ===================== actions ===================== */
// Item codes can contain dots ("HWIRE-06.0-GRN"), so per-item fields keep the code in one piece.
function splitBind(path) {
  var parts = path.split(".");
  if (/^(cnt|kit|kt)$/.test(parts[0]) && parts.length > 2) return [parts[0], parts.slice(1).join(".")];
  if (parts[0] === "ret" && parts.length > 3) return [parts[0], parts.slice(1, -1).join("."), parts[parts.length - 1]];
  return parts;
}
function bindValue(path, value) {
  var parts = splitBind(path), o = S.f;
  for (var i = 0; i < parts.length - 1; i++) { var p = parts[i]; if (o[p] == null) o[p] = /^\d+$/.test(parts[i + 1]) ? [] : {}; o = o[p]; }
  o[parts[parts.length - 1]] = value;
}

// Changing between demo and the real Sheet starts from a clean copy on the phone.
function switchMode(mode) {
  cfg.mode = mode; cfg.token = ""; cfg.user = null; S.users = null; saveCfg();
  SD = emptyData(); Q = []; persist(); rebuild();
}

var A = {
  startDemo: function () { switchMode("demo"); S.f = {}; S.loginMsg = null; render(); },
  back: function () { S.sub = null; S.job = null; S.msg = null; S.f = {}; render(); window.scrollTo(0, 0); },
  sub: function (b) { if (b.dataset.tab2) { S.tab = b.dataset.tab2; S.item = null; S.job = null; } S.sub = b.dataset.sub || null; S.msg = null; S.f = {}; render(); window.scrollTo(0, 0); },
  newJob: function () { S.sub = "new"; S.f = {}; S.msg = null; render(); },
  openJob: function (b) { S.job = b.dataset.job; S.sub = null; S.f = {}; S.msg = null; render(); window.scrollTo(0, 0); },
  addLine: function () { S.f.nj.lines.push({ sku: "", quoted: "" }); render(); },
  delLine: function (b) { S.f.nj.lines.splice(Number(b.dataset.i), 1); if (!S.f.nj.lines.length) S.f.nj.lines.push({ sku: "", quoted: "" }); render(); },
  editJob: function () {
    var j = X.jobs[S.job];
    S.f = { nj: { no: j.no, client: j.client, type: j.type, van: j.van, installer: j.installer, quoteRef: j.quoteRef,
      lines: linesOf(j.no).map(function (l) { return { sku: l.sku, quoted: l.quoted }; }) } };
    S.sub = "new"; S.msg = null; render();
  },
  saveJob: function () {
    var f = S.f.nj;
    var lines = f.lines.filter(function (l) { return l.sku && n(l.quoted) > 0; });
    if (!f.client || !f.van || !f.installer) return flash("err", "Fill in client, van and installer.");
    if (!lines.length) return flash("err", "Add at least one item from the quote.");
    var seen = {};
    for (var i = 0; i < lines.length; i++) { if (seen[lines[i].sku]) return flash("err", nameOf(lines[i].sku) + " is listed twice. Combine them into one line."); seen[lines[i].sku] = 1; }
    var job = { client: f.client, type: f.type || "", van: f.van, installer: f.installer, quoteRef: f.quoteRef || "" };
    function lineRows(no) { return lines.map(function (l) { return { id: no + "|" + l.sku, job: no, sku: l.sku, quoted: C.round2(l.quoted) }; }); }
    if (f.no) {
      job.no = f.no;
      return save([{ op: "upsert", sheet: "Jobs", rows: [job], expect: { field: "status", values: ["quoted"] } },
            { op: "replaceLines", sheet: "Lines", job: f.no, rows: lineRows(f.no) }],
        "Saved " + f.no + ". Next: pick the kit.", function () { S.sub = null; S.job = f.no; S.f = {}; });
    }
    // New job: the Sheet hands out the number, so two devices can never clash.
    job.status = "quoted"; job.created = now();
    save([{ op: "create", sheet: "Jobs", ref: "$JOB", row: job },
          { op: "replaceLines", sheet: "Lines", job: "$JOB", rows: lineRows("$JOB") }],
      "Job created. Next: pick the kit.", function (a) { S.sub = null; S.job = a.$JOB; S.f = {}; S.msg = { k: "ok", t: "Job " + a.$JOB + " created. Next: pick the kit." }; }, { online: true });
  },
  recordKit: function () {
    var j = X.jobs[S.job], sum = C.jobSummary(j.no, D.Lines, D.Moves, X.items), k = S.f.kit || {}, moves = [];
    var used = {};
    for (var i = 0; i < sum.length; i++) {
      var r = sum[i]; if (!(r.quoted > 0)) continue;
      var qty = n(k[r.sku]);
      if (qty < 0) return flash("err", "Kit quantities can't be negative.");
      if (qty === 0) continue;
      if (qty > bal("WH", r.sku) + 1e-9) return flash("err", "Not enough " + nameOf(r.sku) + " in store (" + q(bal("WH", r.sku), r.sku) + "). Receive stock first or lower the kit.");
      if (isSerial(r.sku)) {
        var sers = (S.f.serials && S.f.serials[r.sku]) || [];
        if (sers.length !== qty) return flash("err", "Scan " + qty + " serial numbers for " + nameOf(r.sku) + " (" + sers.length + " so far).");
        for (var s = 0; s < sers.length; s++) {
          var at = serialPlace(sers[s]);
          if (used[sers[s]]) return flash("err", "Serial " + sers[s] + " scanned twice.");
          if (at && at !== "WH") return flash("err", "Serial " + sers[s] + " is not in the store. The records show it at " + at.replace("JOB:", "job ") + ".");
          used[sers[s]] = 1;
          moves.push(mv("kit", r.sku, 1, "WH", "JOB:" + j.no, { job: j.no, van: j.van, installer: j.installer, serial: sers[s] }));
        }
      } else moves.push(mv("kit", r.sku, qty, "WH", "JOB:" + j.no, { job: j.no, van: j.van, installer: j.installer }));
    }
    if (!moves.length) return flash("err", "Nothing to kit. Enter kit quantities.");
    save([{ op: "append", sheet: "Moves", rows: moves }, { op: "upsert", sheet: "Jobs", rows: [{ no: j.no, status: "kitted", kittedAt: now() }], expect: { field: "status", values: ["quoted"] } }],
      "Kit recorded. Put the crate label on and wait for the van.", function () { S.f = {}; });
  },
  collected: function () {
    var j = X.jobs[S.job];
    save([{ op: "upsert", sheet: "Jobs", rows: [{ no: j.no, status: "out", outAt: now() }], expect: { field: "status", values: ["kitted"] } }], j.no + " is on site. Check the crate when it comes back.", function () { S.f = {}; });
  },
  extra: function () { var j = S.job; stopCam(); go("scan"); S.f = { mode: "extra", job: j }; S.msg = { k: "info", t: "Scan or type the sticker of the extra item for " + j + "." }; render(); },
  closeJob: function () {
    var j = X.jobs[S.job], f = S.f.ret || {}, sum = C.jobSummary(j.no, D.Lines, D.Moves, X.items), moves = [], usedBy = {};
    sum.forEach(function (r) {
      if (r.outstanding <= 1e-9) return;
      var x = f[r.sku] || {};
      var base = { job: j.no, van: j.van, installer: j.installer };
      if (n(x.ret) > 0) moves.push(mv("return", r.sku, n(x.ret), "JOB:" + j.no, "WH", base));
      if (n(x.scrap) > 0) moves.push(mv("scrap", r.sku, n(x.scrap), "JOB:" + j.no, "SCRAP", base));
      usedBy[r.sku] = x.used;
    });
    var sum2 = C.jobSummary(j.no, D.Lines, D.Moves.concat(moves), X.items);
    var res = C.closeJob(j, sum2, usedBy, now());
    if (res.problems.length) return flash("err", "Fill in Used for: " + res.problems.map(nameOf).join(", "));
    if (res.missingValue > 0 && !String(f.reason || "").trim()) return flash("err", "Give a reason for the missing stock.");
    res.moves.forEach(function (m) { m.id = uid(); m.by = (cfg.user && cfg.user.username) || ""; });
    save([{ op: "append", sheet: "Moves", rows: moves.concat(res.moves) },
          { op: "upsert", sheet: "Jobs", rows: [{ no: j.no, status: "closed", closedAt: now(), missingValue: res.missingValue, reason: f.reason || "" }], expect: { field: "status", values: ["out"] } }],
      res.missingValue > 0 ? "Job closed. " + R(res.missingValue) + " recorded as missing." : "Job closed. Everything accounted for.", function () { S.f = {}; });
  },
  itemHistory: function (b) { S.item = b.dataset.sku; S.f = {}; S.msg = null; render(); window.scrollTo(0, 0); },
  itemBack: function () { S.item = null; S.f = {}; S.msg = null; render(); },
  revStart: function (b) { S.f.rev = b.dataset.id; S.f.revReason = ""; S.msg = null; render(); },
  revCancel: function () { S.f.rev = null; render(); },
  revConfirm: function (b) {
    var m = D.Moves.find(function (x) { return x.id === b.dataset.id; });
    if (!m || !canReverse(m)) return flash("err", "This movement can't be reversed any more.");
    if (!String(S.f.revReason || "").trim()) return flash("err", "Give a reason for the correction.");
    var r = mv("reverse", m.sku, n(m.qty), m.to, m.from, { reverses: m.type, ref: m.id, job: m.job || "", van: m.van || "", installer: m.installer || "",
      serial: m.serial || "", reason: S.f.revReason.trim() });
    r.value = n(m.value);
    save([{ op: "append", sheet: "Moves", rows: [r] }], "Correction recorded.", function () { S.f = {}; });
  },
  startCam: function () { startCam("Point the camera at a sticker or crate label"); },
  lookup: function () { handleCode(S.f.code); },
  mode: function (b) { S.f.mode = b.dataset.mode; S.msg = null; render(); },
  scanSerials: function (b) {
    var sku = b.dataset.sku;
    var need = b.dataset.need ? Number(b.dataset.need) : n((S.f.kit || {})[sku]);
    S.f.serials = S.f.serials || {}; S.f.serials[sku] = S.f.serials[sku] || [];
    S.scanFor = { sku: sku, need: need, back: S.tab, job: S.job, keep: S.f };
    S.tab = "scan"; S.msg = null; render();
    startCam("Scan the serial barcode on each " + nameOf(sku));
  },
  addSerial: function () { addSerial(S.f.serManual); S.f.serManual = ""; render(); },
  doneSerials: function () {
    var sf = S.scanFor; stopCam(); S.scanFor = null;
    S.tab = sf.back; S.job = sf.job; S.msg = null; render();
  },
  postMove: function () {
    var f = S.f, it = X.items[f.sku], mode = f.mode || "receive";
    if (!it) return flash("err", "Scan an item first.");
    var serial = isSerial(it.sku), sers = (f.serials && f.serials[it.sku]) || [];
    var qty = mode === "receive" && serial ? sers.length : n(f.qty);
    if (!(qty > 0)) return flash("err", mode === "receive" && serial ? "Scan the serial numbers first." : "Enter a quantity above zero.");
    var ops = [], moves = [], label = { label: f.label || "" };
    if (mode === "receive") {
      if (f.cost == null && !(n(it.cost) > 0) || f.cost === "") return flash("err", "Enter the landed cost per " + UNIT[unitOfSku(it.sku)].per + ", excluding VAT.");
      var c = f.cost == null ? n(it.cost) : n(f.cost);
      var avg = C.newAverageCost(C.onHand(X.B, it.sku), n(it.cost), qty, c);
      if (serial) sers.forEach(function (s) { var m = mv("receive", it.sku, 1, "SUPPLIER", "WH", { unitCost: c, ref: f.ref || "", serial: s }); m.value = c; moves.push(m); });
      else { var m = mv("receive", it.sku, qty, "SUPPLIER", "WH", Object.assign({ unitCost: c, ref: f.ref || "" }, label)); m.value = C.round2(qty * c); moves.push(m); }
      ops.push({ op: "append", sheet: "Moves", rows: moves }, { op: "upsert", sheet: "Items", rows: [{ sku: it.sku, cost: avg }] });
    } else if (mode === "extra") {
      if (serial) return flash("err", "For panels and inverters, add them to the job's quote and kit them, so the serials are recorded.");
      var j = X.jobs[f.job];
      if (!j) return flash("err", "Choose the job.");
      if (!String(f.reason || "").trim()) return flash("err", "Give a reason for the extra stock.");
      if (qty > bal("WH", it.sku) + 1e-9) return flash("err", "Only " + q(bal("WH", it.sku), it.sku) + " in store.");
      ops.push({ op: "append", sheet: "Moves", rows: [mv("extra", it.sku, qty, "WH", "JOB:" + j.no, { job: j.no, van: j.van, installer: j.installer, reason: f.reason })] });
    } else {
      if (!f.van) return flash("err", "Choose the van.");
      if (qty > bal("WH", it.sku) + 1e-9) return flash("err", "Only " + q(bal("WH", it.sku), it.sku) + " in store.");
      ops.push({ op: "append", sheet: "Moves", rows: [mv("topup", it.sku, qty, "WH", f.van, { van: f.van })] });
    }
    var done = { receive: "Received ", extra: "Extra issued: ", topup: "Van topped up: " }[mode] + q(qty, it.sku) + " " + it.name + ".";
    save(ops, done, function () { var keep = { sku: it.sku, label: f.label, mode: mode, job: f.job, van: f.van }; S.f = keep; });
  },
  saveCount: function () {
    var place = S.f.place || "WH", c = S.f.cnt || {};
    var counted = Object.keys(c).filter(function (k) { return c[k] !== "" && c[k] != null; });
    if (!counted.length) return flash("err", "Enter at least one count.");
    if (place !== "WH" && counted.length < X.kit.length) return flash("err", "Count every line of the van kit, even if it's zero.");
    if (place === "WH" && !canManage()) {
      // Storeman: the count is a submission. Stock only changes when an admin approves it.
      var lines = C.countLines(place, c, X.B, X.items);
      var value = C.round2(lines.reduce(function (s, l) { return s + l.value; }, 0));
      return save([{ op: "upsert", sheet: "Counts", rows: [{ id: "CNT-" + uid(), place: place, ts: now(), status: "pending", lines: JSON.stringify(lines), value: value, note: S.f.cnote || "" }] }],
        "Count submitted. A Warehouse Manager will approve it before stock changes.", function () { S.f.cnt = {}; S.f.cnote = ""; });
    }
    var moves = C.countMoves(place, c, X.B, X.items, now(), place === "WH" ? "Shelf count" : "Van count");
    moves.forEach(function (m) { m.id = uid(); m.by = (cfg.user && cfg.user.username) || ""; });
    if (!moves.length) { S.f.cnt = {}; return flash("ok", "Count matches the system. Nothing to adjust."); }
    var short = moves.filter(function (m) { return m.type === "countshort"; }).reduce(function (s, m) { return s + n(m.value); }, 0);
    save([{ op: "append", sheet: "Moves", rows: moves }],
      place === "WH" ? (short > 0 ? "Count saved. " + R(short) + " short on the shelves." : "Count saved.") : "Van count saved. Top up to target from Scan.", function () { S.f.cnt = {}; });
  },
  editItem: function (b) { var i = X.items[b.dataset.sku]; S.f.it = Object.assign({ editing: true }, i); S.msg = null; render(); window.scrollTo(0, 0); },
  saveItem: function () {
    var f = S.f.it, sku = f.editing ? f.sku : C.normCode(f.sku);
    if (!sku || sku.length > 40) return flash("err", "Give the item a code, up to 40 characters.");
    if (!f.name) return flash("err", "Add a description.");
    if (!f.editing && (X.items[sku] || X.labels[sku] || X.jobs[sku])) return flash("err", "That code is already used.");
    var row = { sku: sku, name: f.name, uom: UNIT[f.uom] ? f.uom : "m", track: f.track === "serial" ? "serial" : "qty", reorder: n(f.reorder), allowancePct: f.allowancePct === "" ? "" : n(f.allowancePct) };
    if (!f.editing) row.cost = 0;
    save([{ op: "upsert", sheet: "Items", rows: [row] }], (f.editing ? "Saved " : "Added ") + sku + ".", function () { S.f.it = { uom: "m", track: "qty", allowancePct: "10" }; });
  },
  saveLabel: function () {
    var f = S.f.lb;
    if (!f.sku) return flash("err", "Choose the item.");
    save([{ op: "create", sheet: "Labels", ref: "$L", row: { sku: f.sku, note: f.note || "" } }], "Sticker created.",
      function (a) { S.f.lb = { sku: f.sku }; S.msg = { k: "ok", t: "Sticker " + a.$L + " created." }; }, { online: true });
  },
  printLabels: function () {
    printSheet("Sticker sheet", D.Labels.slice().sort(function (a, b) { return a.code.localeCompare(b.code); }).map(function (l) {
      return { qr: qrImg(labelLink(l.code), 5), title: l.code, line1: nameOf(l.sku), line2: l.note };
    }), 3);
  },
  printCrate: function () {
    var j = X.jobs[S.job];
    printSheet("Crate " + j.no, [{ qr: qrImg(labelLink(j.no), 8), title: j.no, line1: j.client, line2: vanName(j.van) + " · " + j.installer }], 1);
  },
  saveVan: function () {
    var f = S.f.vn; if (!f.name) return flash("err", "Give the van a name.");
    save([{ op: "create", sheet: "Vans", ref: "$V", row: { name: f.name } }], "Van added.", function () { S.f.vn = {}; }, { online: true });
  },
  saveKit: function () {
    var t = S.f.kt || {}, up = [], rm = [];
    Object.keys(t).forEach(function (sku) { if (n(t[sku]) > 0) up.push({ sku: sku, target: n(t[sku]) }); else if (D.VanKit.some(function (k) { return k.sku === sku; })) rm.push({ sku: sku }); });
    var ops = [];
    if (up.length) ops.push({ op: "upsert", sheet: "VanKit", rows: up });
    if (rm.length) ops.push({ op: "remove", sheet: "VanKit", rows: rm });
    if (!ops.length) return flash("err", "Enter at least one quantity.");
    save(ops, "Van kit saved.");
  },
  syncNow: function () { flush(); flash("info", "Trying to sync…"); },
  /* ---- sign in / account ---- */
  goLive: function () {
    if (cfg.mode === "live" && cfg.url) { S.f = {}; S.msg = null; return render(); }
    if (Q.length) return flash("err", Q.length + " change(s) are still waiting to sync. Let them sync first.");
    switchMode("live"); cfg.url = ""; saveCfg(); S.f = {}; S.msg = null; S.loginMsg = null; render();
  },
  useDemo: function () {
    if (cfg.mode === "live" && Q.length) return flash("err", Q.length + " change(s) are still waiting to reach the Sheet. Let them sync first.");
    switchMode("demo"); S.f = {}; S.msg = null; S.loginMsg = null; render();
  },
  changeUrl: function () {
    if (Q.length) return flash("err", Q.length + " change(s) are still waiting to reach the current Sheet. Let them sync first.");
    switchMode("live"); cfg.url = ""; saveCfg(); S.f = {}; S.msg = null; render();
  },
  login: function () {
    var f = S.f.lg || {}, username = String(f.username || "").trim().toLowerCase();
    if (cfg.mode === "live" && !cfg.url) {
      var url = String(f.url || "").trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url)) return flash("err", "The web app link should start with https://script.google.com/macros/s/ and end with /exec.");
      cfg.url = url;
    }
    if (!username || !f.pin) return flash("err", "Enter your username and PIN.");
    if (Q.length && Q[0].user && Q[0].user !== username) return flash("err", Q.length + " change(s) by " + Q[0].user + " are still waiting to sync on this phone. " + Q[0].user + " must sign in first, so the record shows who did them.");
    S.busy = true; S.msg = null; render();
    api.call("login", { username: username, pin: String(f.pin) }).then(function (res) {
      cfg.token = res.token; cfg.user = res.user; saveCfg();
      S.f = {}; S.loginMsg = null; S.loading = !res.user.mustChange; S.tab = "jobs";
      if (!res.user.mustChange) reload().then(openPendingCode);
    }).catch(function (e) {
      if (cfg.mode === "live" && e.net && !SD.Items.length) cfg.url = "";   // first connection failed: let them fix the link
      S.f.lg.pin = "";
      S.msg = { k: "err", t: e.net ? "Couldn't reach the Google Sheet. Check the link, that the deployment allows Anyone, and that you have signal." : e.message };
    }).then(function () { S.busy = false; saveCfg(); render(); });
  },
  firstPin: function () { changePinFrom("cp"); },
  changePin: function () { changePinFrom("ac"); },
  logout: function () {
    if (Q.length && !S.f.confirmLogout) { S.f.confirmLogout = true; return render(); }
    var t = cfg.token;
    if (t) api.call("logout", {}).catch(function () {});
    cfg.token = ""; saveCfg(); stopCam();
    S.f = {}; S.msg = null; S.loginMsg = "Signed out."; S.tab = "jobs"; S.sub = null; S.job = null; S.item = null;
    render();
  },
  saveConnection: function () {
    var f = S.f.ac || {};
    var url = String(f.url || "").trim(), site = String(f.site || "").trim();
    cfg.site = site; saveCfg();
    if (cfg.mode === "live" && url && url !== cfg.url) {
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url)) return flash("err", "The web app link should start with https://script.google.com/macros/s/ and end with /exec.");
      if (Q.length) return flash("err", Q.length + " change(s) are still waiting to reach the current Sheet. Let them sync first.");
      switchMode("live"); cfg.url = url; saveCfg(); S.loginMsg = "Sign in to the new Google Sheet."; S.f = {}; return render();
    }
    flash("ok", "Saved.");
  },
  emptyDemo: function () {
    if (!isAdmin()) return flash("err", "Only a Senior Admin can clear the data.");
    if (!S.f.confirmEmpty) { S.f.confirmEmpty = true; return render(); }
    var d = LS.get("sc_demo", null) || seedDemo();
    var empty = { Items: [], Jobs: [], Lines: [], Moves: [], Labels: [], Vans: d.Vans || [], VanKit: [], Counts: [] };
    LS.set("sc_demo", empty); LS.set("sc_demo_batches", null); LS.set("sc_demo_kind", "empty");
    SD = emptyData(); Q = []; persist(); rebuild();
    S.f = {}; S.loading = true; render();
    fullReload().then(function () { S.tab = "more"; S.sub = "inventory"; S.f = { invTab: "io", imp: { mode: "receive", text: "" } };
      S.msg = { k: "ok", t: "All stock, items, jobs, stickers and counts cleared. Add your stock below: choose the file or paste the lines, add the supplier and invoice number, then Preview." }; render(); window.scrollTo(0, 0); });
  },
  resetDemo: function () {
    LS.set("sc_demo_kind", null);
    LS.set("sc_demo", null); LS.set("sc_demo_batches", null); LS.set("sc_demo_users", null); LS.set("sc_demo_sessions", null);
    switchMode("demo"); S.f = {}; S.loginMsg = "Demo data reset. Sign in with one of the demo logins."; render();
  },

  /* ---- inventory (manager + senior admin) ---- */
  invTab: function (b) { S.f = { invTab: b.dataset.t }; S.msg = null; render(); },
  refreshAll: function () {
    if (Q.length) { flush(); return flash("info", Q.length + " change(s) from this phone are being sent first. Tap Refresh again in a moment."); }
    S.busy = true; render();
    fullReload().then(function () { S.busy = false; S.msg = S.msg && S.msg.k === "err" ? S.msg : { k: "ok", t: "Up to date with the Google Sheet." }; render(); });
  },
  approveCount: function (b) {
    var c = (D.Counts || []).find(function (x) { return x.id === b.dataset.id; });
    if (!c || c.status !== "pending") return flash("err", "This count has already been decided.");
    if (c.by === cfg.user.username) return flash("err", "You can't approve your own count.");
    var moves = C.linesToMoves(c.place, countLinesOf(c), X.items, now(), "Count by " + c.by + ", approved", c.id);
    moves.forEach(function (m) { m.id = uid(); m.by = cfg.user.username; });
    var ops = [];
    if (moves.length) ops.push({ op: "append", sheet: "Moves", rows: moves });
    ops.push({ op: "upsert", sheet: "Counts", rows: [{ id: c.id, status: "approved", decidedAt: now() }], expect: { field: "status", values: ["pending"] } });
    save(ops, "Count approved. " + (moves.length ? moves.length + " adjustment(s) booked (" + R(c.value) + ")." : "Nothing to adjust."), function () { S.f.invTab = "approve"; });
  },
  rejStart: function (b) { S.f.rejecting = b.dataset.id; S.f.rejNote = ""; render(); },
  rejCancel: function () { S.f.rejecting = null; render(); },
  rejectCount: function (b) {
    if (!String(S.f.rejNote || "").trim()) return flash("err", "Give a reason, so the counter knows what to fix.");
    save([{ op: "upsert", sheet: "Counts", rows: [{ id: b.dataset.id, status: "rejected", decidedAt: now(), decisionNote: S.f.rejNote.trim() }], expect: { field: "status", values: ["pending"] } }],
      "Count rejected. Stock not changed.", function () { S.f.rejecting = null; S.f.invTab = "approve"; });
  },
  adjDir: function (b) { S.f.adj.dir = b.dataset.d; render(); },
  saveAdjust: function () {
    var f = S.f.adj, it = X.items[f.sku], qty = n(f.qty);
    if (!it) return flash("err", "Choose the item.");
    if (!(qty > 0)) return flash("err", "Enter a quantity above zero.");
    if (!String(f.note || "").trim()) return flash("err", "Add the details. They're saved with the adjustment for the audit trail.");
    var place = f.place || "WH", van = place === "WH" ? "" : place;
    var m = f.dir === "remove" ? mv("adjust", it.sku, qty, place, "LOSS", { van: van, reason: f.reason + ": " + f.note.trim() })
                               : mv("adjust", it.sku, qty, "LOSS", place, { van: van, reason: f.reason + ": " + f.note.trim() });
    save([{ op: "append", sheet: "Moves", rows: [m] }], "Adjustment saved: " + (f.dir === "remove" ? "−" : "+") + q(qty, it.sku) + " " + it.name + ".",
      function () { S.f.adj = { dir: f.dir, place: place, reason: f.reason }; S.f.invTab = "adjust"; });
  },
  impMode: function (b) { S.f.imp.mode = b.dataset.m; S.f.imp.preview = null; render(); },
  previewImport: function () {
    var f = S.f.imp;
    if (!String(f.text || "").trim()) return flash("err", "Paste the rows from Excel first.");
    f.preview = C.parseImport(f.text, X.items); S.msg = null;
    if (!f.preview.rows.length && !f.preview.errors.length) f.preview.errors.push("No rows found. Check the item code is in the first column and the quantity in the second.");
    render();
  },
  applyImport: function () {
    var f = S.f.imp, rows = (f.preview || {}).rows || [];
    if (!rows.length || f.preview.errors.length) return flash("err", "Preview again and fix any problems first.");
    if (f.mode === "receive") {
      if (!String(f.ref || "").trim()) return flash("err", "Add the supplier and invoice number, so this delivery can be traced and isn't received twice.");
      if (findReceipt(f.ref) && !f.dupOk) return flash("err", "This invoice was already received. Tick the box if it really is a separate delivery.");
    }
    var t = now(), itemOps = [], itemsAfter = Object.assign({}, X.items), moves = [];
    rows.forEach(function (r) {
      if (r.isNew) {
        var ni = { sku: r.sku, name: r.name, uom: r.uom || "ea", track: "qty", cost: r.cost != null ? r.cost : 0, reorder: 0, allowancePct: isLen(r.uom) ? 10 : "" };
        itemOps.push(ni); itemsAfter[r.sku] = ni;
      }
    });
    if (f.mode === "set") {
      rows.forEach(function (r) {
        if (!r.isNew && r.cost != null && r.cost !== n(X.items[r.sku].cost)) { itemOps.push({ sku: r.sku, cost: r.cost }); itemsAfter[r.sku] = Object.assign({}, itemsAfter[r.sku], { cost: r.cost }); }
      });
      var counts = {}; rows.forEach(function (r) { counts[r.sku] = r.qty; });
      moves = C.linesToMoves("WH", C.countLines("WH", counts, X.B, itemsAfter), itemsAfter, t, "Imported stock take", "IMPORT-" + t.slice(0, 10));
    } else {
      rows.forEach(function (r) {
        if (!(r.qty > 0)) return;
        var c = r.cost != null ? r.cost : n(itemsAfter[r.sku].cost);
        var m = { ts: t, type: "receive", sku: r.sku, qty: r.qty, from: "SUPPLIER", to: "WH", unitCost: c, value: C.round2(r.qty * c), ref: String(f.ref).trim() };
        moves.push(m);
        if (!r.isNew) itemOps.push({ sku: r.sku, cost: C.newAverageCost(C.onHand(X.B, r.sku), n(X.items[r.sku].cost), r.qty, c) });
      });
    }
    moves.forEach(function (m) { m.id = uid(); m.by = cfg.user.username; });
    var ops = [];
    if (itemOps.length) ops.push({ op: "upsert", sheet: "Items", rows: itemOps });
    if (moves.length) ops.push({ op: "append", sheet: "Moves", rows: moves });
    if (!ops.length) return flash("ok", "Everything already matches. Nothing to change.");
    var newCount = rows.filter(function (r) { return r.isNew; }).length;
    save(ops, "Imported " + rows.length + " line(s)" + (newCount ? ", " + newCount + " new item(s)" : "") + ", " + moves.length + " movement(s).",
      function () { S.f.imp = { mode: f.mode, text: "" }; S.f.invTab = "io"; });
  },
  exportStock: function () {
    var vanIds = X.vans.map(function (v) { return v.id; });
    function cell(v) { v = String(v == null ? "" : v); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var out = [["Item code", "Store qty", "Landed cost", "Name", "Unit", "In vans", "On jobs", "Value"].join(",")];
    D.Items.slice().sort(function (a, b) { return a.sku.localeCompare(b.sku); }).forEach(function (it) {
      var wh = bal("WH", it.sku), vv = 0, jb = 0;
      vanIds.forEach(function (v) { vv += bal(v, it.sku); });
      Object.keys(X.B).forEach(function (l) { if (l.indexOf("JOB:") === 0) jb += bal(l, it.sku); });
      out.push([it.sku, C.round2(wh), n(it.cost).toFixed(2), it.name, UNIT[it.uom] ? it.uom : "ea", C.round2(vv), C.round2(jb), (C.round2(wh + vv + jb) * n(it.cost)).toFixed(2)].map(cell).join(","));
    });
    var blob = new Blob(["\ufeff" + out.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "stock-" + now().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    flash("ok", "Stock list downloaded.");
  },

  /* ---- logins (admin) ---- */
  newUser: function () { S.f.us = null; S.f.tempPin = null; S.msg = null; render(); },
  editUser: function (b) {
    var u = (S.users || []).find(function (x) { return x.username === b.dataset.u; });
    if (!u) return;
    S.f.us = { isNew: false, username: u.username, name: u.name, role: u.role, origRole: u.role, active: u.active, pin: suggestPin(6) };
    S.f.tempPin = null; S.msg = null; render(); window.scrollTo(0, 0);
  },
  saveUser: function () {
    var f = S.f.us;
    if (f.isNew || (isMgrRole(f.role) && !isMgrRole(f.origRole))) { var pp = pinProblem(f.pin, f.role); if (pp) return flash("err", pp); }
    S.busy = true; S.msg = null; render();
    var promoted = !f.isNew && isMgrRole(f.role) && !isMgrRole(f.origRole);
    api.call("users", { cmd: "save", isNew: !!f.isNew, user: { username: f.username, name: f.name, role: f.role, active: f.active }, pin: (f.isNew || promoted) ? String(f.pin) : undefined })
      .then(function (res) {
        S.users = res.users;
        S.f.tempPin = (f.isNew || promoted) ? { name: f.name, pin: String(f.pin) } : null;
        S.f.us = null;
        S.msg = { k: "ok", t: f.isNew ? "Login added for " + f.name + "." : "Saved." };
      }).catch(function (e) { if (!e.signIn) S.msg = { k: "err", t: e.net ? "Managing logins needs signal." : e.message }; })
      .then(function () { S.busy = false; render(); window.scrollTo(0, 0); });
  },
  resetUserPin: function () {
    var f = S.f.us, pin = suggestPin(isMgrRole(f.role) ? 6 : 4);
    S.busy = true; S.msg = null; render();
    api.call("users", { cmd: "resetPin", username: f.username, pin: pin }).then(function (res) {
      S.users = res.users; S.f.tempPin = { name: f.name, pin: pin }; S.f.us = null;
      S.msg = { k: "ok", t: "PIN reset. " + f.name + " has been signed out everywhere." };
    }).catch(function (e) { if (!e.signIn) S.msg = { k: "err", t: e.net ? "Managing logins needs signal." : e.message }; })
      .then(function () { S.busy = false; render(); window.scrollTo(0, 0); });
  },
  openJobFrom: function (b) { S.tab = "jobs"; S.sub = null; S.item = null; S.job = b.dataset.job; S.f = {}; S.msg = null; render(); window.scrollTo(0, 0); }
};

function changePinFrom(grp) {
  var f = S.f[grp] || {};
  if (!f.old) return flash("err", "Enter your current PIN.");
  var pp = pinProblem(f.new1, role()); if (pp) return flash("err", pp);
  if (f.new1 !== f.new2) return flash("err", "The two new PINs don't match.");
  S.busy = true; S.msg = null; render();
  api.call("changePin", { oldPin: String(f.old), newPin: String(f.new1) }).then(function (res) {
    var first = cfg.user.mustChange;
    cfg.user = res.user; saveCfg(); S.f[grp] = {};
    S.msg = { k: "ok", t: "PIN changed." };
    if (first) { S.loading = true; reload().then(openPendingCode); }
  }).catch(function (e) { S.msg = { k: "err", t: e.net ? "Changing your PIN needs signal." : e.message }; })
    .then(function () { S.busy = false; render(); });
}

function printSheet(title, cells, cols) {
  var w = window.open("", "_blank");
  if (!w) return flash("err", "Allow pop-ups for this site to print.");
  var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + "</title><style>@page{size:A4;margin:10mm}body{font-family:Arial,sans-serif;margin:0}" +
    ".g{display:grid;grid-template-columns:repeat(" + cols + ",1fr);gap:3mm}.c{border:0.2mm dashed #999;display:flex;align-items:center;gap:3mm;padding:2mm;break-inside:avoid;font-size:9pt}" +
    (cols === 1 ? ".c{flex-direction:column;padding:10mm;font-size:16pt}.c img{width:90mm;height:90mm}" : ".c{height:33mm}.c img{width:28mm;height:28mm}") +
    "img{image-rendering:pixelated}b{font-size:1.25em;font-family:monospace}</style></head><body><div class=\"g\">" +
    cells.map(function (c) { return '<div class="c"><img src="' + c.qr + '"><div><b>' + esc(c.title) + "</b><br>" + esc(c.line1) + "<br><small>" + esc(c.line2 || "") + "</small></div></div>"; }).join("") +
    "</div><script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>";
  w.document.open(); w.document.write(html); w.document.close();
}

/* ===================== scanning ===================== */
var cam = null, lastCode = "", lastAt = 0;
function startCam(title) {
  if (!window.Html5Qrcode) return flash("err", "The scanner didn't load. Check the internet connection, or type the code.");
  if (cam) return;
  $("#camBox").hidden = false; $("#camTitle").textContent = title || "Point the camera at the sticker"; $("#camHint").textContent = "";
  cam = new Html5Qrcode("reader", { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
  cam.start({ facingMode: "environment" }, {
    fps: 10, qrbox: function (w, h) { return { width: Math.floor(w * 0.8), height: Math.floor(Math.min(w, h) * 0.6) }; }
  }, function (text) {
    var t = Date.now();
    if (text === lastCode && t - lastAt < 2500) return;
    lastCode = text; lastAt = t;
    if (navigator.vibrate) navigator.vibrate(60);
    onScan(text);
  }, function () {}).catch(function () {
    stopCam(); flash("err", "Camera blocked. Allow camera access for this site in Chrome (tap the lock icon by the address), then try again.");
  });
  $("#camBox").scrollIntoView({ behavior: "smooth", block: "start" });
}
function stopCam() {
  if (cam) { var c = cam; cam = null; c.stop().then(function () { c.clear(); }).catch(function () {}); }
  $("#camBox").hidden = true;
}
function onScan(text) {
  if (S.scanFor) {
    addSerial(text);
    var list = S.f.serials[S.scanFor.sku];
    $("#camHint").textContent = list.length + " scanned · last: " + list[list.length - 1];
    if (list.length >= S.scanFor.need) { A.doneSerials(); return; }
    render(); return;
  }
  stopCam();
  handleCode(text);
}
function addSerial(raw) {
  var s = String(raw || "").trim().toUpperCase();
  if (!s) return;
  var sf = S.scanFor, kept = sf.keep || S.f;
  kept.serials = kept.serials || {};
  var list = kept.serials[sf.sku] = kept.serials[sf.sku] || [];
  S.f = kept;
  if (list.indexOf(s) >= 0) { S.msg = { k: "warn", t: s + " already scanned." }; return; }
  if (list.length >= sf.need) { S.msg = { k: "warn", t: "Already have " + sf.need + " serials." }; return; }
  list.push(s); S.msg = null;
}
function handleCode(raw) {
  var code = C.parseScan(raw);
  if (!code) return flash("err", "Scan or type a code first.");
  if (X.jobs[code]) {
    var j = X.jobs[code];
    S.tab = "jobs"; S.sub = null; S.job = code; S.f = {};
    S.msg = j.status === "kitted" ? { k: "info", t: "Crate for " + code + ". If the van is collecting it now, tap the button below." }
      : j.status === "out" ? { k: "info", t: "Crate for " + code + " is back? Check every line below." } : null;
    render(); window.scrollTo(0, 0); return;
  }
  var sku = X.labels[code] ? X.labels[code].sku : X.items[code] ? code : null;
  if (sku && !canWork()) { S.tab = "stock"; S.item = sku; S.sub = null; S.job = null; S.f = {}; S.msg = null; render(); window.scrollTo(0, 0); return; }
  if (!sku) { S.tab = "scan"; S.f = { code: code }; return flash("err", code + " isn't a sticker, job or item in the system. Check the code, or create the sticker in More → Stickers."); }
  var keep = S.f.mode === "extra" ? { mode: "extra", job: S.f.job } : {};
  S.tab = "scan"; S.f = Object.assign({ sku: sku, label: X.labels[code] ? code : "", code: "" }, keep); S.msg = null; render();
}

/* ===================== events ===================== */
document.addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  if (b.id === "navBack") { history.back(); return; }
  if (b.id === "navFwd") { history.forward(); return; }
  if (b.id === "navHome") {
    $("#homeConfirmText").textContent = Q.length ? Q.length + " change(s) haven't reached the Sheet yet. They'll sync next time you sign in on this phone. Sign out and go to the login page?" : "Sign out and go to the login page?";
    $("#homeConfirm").hidden = false; return;
  }
  if (b.id === "homeNo") { $("#homeConfirm").hidden = true; return; }
  if (b.id === "homeYes") { $("#homeConfirm").hidden = true; S.f.confirmLogout = true; A.logout(); window.scrollTo(0, 0); return; }
  if (b.id === "camStop") { if (S.scanFor) A.doneSerials(); else stopCam(); return; }
  if (b.dataset.tab) {
    if (b.dataset.tab === "scan") { S.scanFor = null; go("scan"); startCam(); return; }
    return go(b.dataset.tab);
  }
  var a = b.dataset.action;
  if (a && A[a]) { if (S.busy) return; A[a](b); }
});
document.addEventListener("input", function (e) {
  var t = e.target;
  if (!t.dataset || !t.dataset.bind) return;
  if (t.type === "checkbox") { bindValue(t.dataset.bind, t.checked); render(); return; }
  bindValue(t.dataset.bind, t.value);
  if (t.id === "us_role" && S.f.us && pinProblem(S.f.us.pin, t.value)) S.f.us.pin = suggestPin(isMgrRole(t.value) ? 6 : 4);
  if (t.id === "cnt_flt") { render(); return; }
  if (t.tagName === "SELECT") { if (t.dataset.reset) S.f[t.dataset.reset] = {}; render(); return; }
  if (t.dataset.live) { if (t.id.indexOf("cnt_") === 0) patchCounts(); else patchReturn(); }
});
document.addEventListener("change", function (e) {
  var t = e.target;
  if (t.id === "imp_file" && t.files && t.files[0]) {
    var file = t.files[0];
    if (file.size > 2e6) { t.value = ""; return flash("err", "That file is too big. Save just the stock lines as a CSV."); }
    var rd = new FileReader();
    rd.onload = function () {
      S.f.imp.text = String(rd.result || "").replace(/^\ufeff/, "");
      if (!S.f.imp.ref && /INV\w+/i.test(file.name)) S.f.imp.ref = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      A.previewImport();
    };
    rd.onerror = function () { flash("err", "Couldn't read that file."); };
    rd.readAsText(file);
    t.value = "";
    return;
  }
  if (t.dataset && t.dataset.rerender && t.tagName !== "SELECT" && t.type !== "checkbox") render();
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  if (e.target.id === "sc_code") { e.preventDefault(); A.lookup(); }
  if (e.target.id === "ser_manual") { e.preventDefault(); A.addSerial(); }
});
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && cfg.mode === "live" && !S.busy) pull(); });

/* ===================== demo data ===================== */
function demoKind() { return LS.get("sc_demo_kind", null) === "empty" ? "empty" : "example"; }
function seedDemo() {
  var d = { Items: [], Jobs: [], Lines: [], Moves: [], Labels: [], Vans: [], VanKit: [], Counts: [] };
  function ago(days, h) { var t = new Date(Date.now() - days * 864e5); t.setHours(h || 8, 0, 0, 0); return t.toISOString(); }
  var items = [
    ["PV6-RED", "PV cable 6 mm² red", "m", "qty", 18.5, 200, 10], ["PV6-BLK", "PV cable 6 mm² black", "m", "qty", 18.5, 200, 10],
    ["AC4-3C", "AC cable 4 mm² 3-core", "m", "qty", 42, 50, 10], ["PNL-550", "Solar panel 550 W", "ea", "serial", 1850, 10, ""],
    ["INV-5KW", "Hybrid inverter 5 kW", "ea", "serial", 14500, 2, ""], ["RAIL-42", "Mounting rail 4.2 m", "ea", "qty", 380, 20, ""],
    ["MC4", "MC4 connector pair", "ea", "qty", 28, 40, ""], ["TIES-100", "Cable ties, pack of 100", "ea", "qty", 35, 10, ""],
    ["LUG-16", "Lug 16 mm²", "ea", "qty", 6, 50, ""], ["FUSE-DC", "DC fuse 15 A", "ea", "qty", 22, 20, ""]
  ];
  var I = {};
  items.forEach(function (x) { var o = { sku: x[0], name: x[1], uom: x[2], track: x[3], cost: x[4], reorder: x[5], allowancePct: x[6] }; d.Items.push(o); I[o.sku] = o; });
  d.Vans = [{ id: "VAN-1", name: "Van 1 · Hilux" }, { id: "VAN-2", name: "Van 2 · Quantum" }];
  d.VanKit = [{ sku: "MC4", target: 10 }, { sku: "TIES-100", target: 2 }, { sku: "LUG-16", target: 20 }, { sku: "FUSE-DC", target: 6 }];
  [["PV6-RED", "Drum 1 · 500 m"], ["PV6-BLK", "Drum 1 · 500 m"], ["AC4-3C", "Drum · 100 m"], ["MC4", "Shelf bin A1"], ["RAIL-42", "Rack R1"],
   ["TIES-100", "Shelf bin A2"], ["LUG-16", "Shelf bin A3"], ["FUSE-DC", "Shelf bin A4"]].forEach(function (x, i) { d.Labels.push({ code: "GS-000" + (i + 1), sku: x[0], note: x[1] }); });
  var k = 0;
  function M(ts, type, sku, qty, from, to, extra) {
    var m = Object.assign({ id: "demo" + (++k), ts: ts, type: type, sku: sku, qty: qty, from: from, to: to, by: "sipho", value: C.round2(qty * I[sku].cost) }, extra || {});
    d.Moves.push(m); return m;
  }
  var ref = { ref: "Container MSKU 48120 (example)" };
  [["PV6-RED", 500], ["PV6-BLK", 500], ["AC4-3C", 100], ["RAIL-42", 40], ["MC4", 100], ["TIES-100", 20], ["LUG-16", 200], ["FUSE-DC", 60]].forEach(function (x) {
    M(ago(21), "receive", x[0], x[1], "SUPPLIER", "WH", Object.assign({ unitCost: I[x[0]].cost }, ref));
  });
  var panels = [], invs = [];
  for (var p = 1; p <= 24; p++) { var s = "JA550-24-" + ("000" + p).slice(-4); panels.push(s); M(ago(21), "receive", "PNL-550", 1, "SUPPLIER", "WH", Object.assign({ unitCost: 1850, serial: s }, ref)); }
  for (var v = 1; v <= 3; v++) { var s2 = "SN5K-A0" + (190 + v); invs.push(s2); M(ago(21), "receive", "INV-5KW", 1, "SUPPLIER", "WH", Object.assign({ unitCost: 14500, serial: s2 }, ref)); }
  ["VAN-1", "VAN-2"].forEach(function (van) { d.VanKit.forEach(function (kk) { M(ago(20), "topup", kk.sku, kk.target, "WH", van, { van: van }); }); });

  function job(no, client, type, van, inst, quote, lines, created) {
    var j = { no: no, client: client, type: type, van: van, installer: inst, quoteRef: quote, status: "quoted", created: created };
    d.Jobs.push(j);
    lines.forEach(function (l) { d.Lines.push({ id: no + "|" + l[0], job: no, sku: l[0], quoted: l[1] }); });
    return j;
  }
  function kit(j, ts, serialMap) {
    d.Lines.filter(function (l) { return l.job === j.no; }).forEach(function (l) {
      var base = { job: j.no, van: j.van, installer: j.installer };
      if (I[l.sku].track === "serial") (serialMap[l.sku] || []).forEach(function (s) { M(ts, "kit", l.sku, 1, "WH", "JOB:" + j.no, Object.assign({ serial: s }, base)); });
      else M(ts, "kit", l.sku, C.kitDefault(I[l.sku], l.quoted), "WH", "JOB:" + j.no, base);
    });
    j.status = "kitted"; j.kittedAt = ts;
  }
  function out(j, ts) { j.status = "out"; j.outAt = ts; }
  function close(j, ts, back, scrap, used, reason) {
    var base = { job: j.no, van: j.van, installer: j.installer };
    Object.keys(back).forEach(function (s) { M(ts, "return", s, back[s], "JOB:" + j.no, "WH", base); });
    Object.keys(scrap).forEach(function (s) { M(ts, "scrap", s, scrap[s], "JOB:" + j.no, "SCRAP", base); });
    var sum = C.jobSummary(j.no, d.Lines, d.Moves, I);
    var res = C.closeJob(j, sum, used, ts);
    res.moves.forEach(function (m) { m.id = "demo" + (++k); m.by = "sipho"; d.Moves.push(m); });
    j.status = "closed"; j.closedAt = ts; j.missingValue = res.missingValue; j.reason = reason || "";
  }

  var j1 = job("J-1001", "Botha, Durbanville", "5 kW hybrid rooftop", "VAN-1", "Sipho", "Q-2201", [["PV6-RED", 30], ["PV6-BLK", 30], ["RAIL-42", 8], ["PNL-550", 6], ["INV-5KW", 1]], ago(19));
  kit(j1, ago(18, 15), { "PNL-550": panels.slice(0, 6), "INV-5KW": invs.slice(0, 1) }); out(j1, ago(17, 7));
  close(j1, ago(15, 16), { "PV6-RED": 1 }, { "PV6-RED": 0.5 }, { "PV6-RED": 29, "PV6-BLK": 31, "RAIL-42": 8, "PNL-550": 6, "INV-5KW": 1 }, "Offcuts left on site");

  var j2 = job("J-1002", "Naidoo, Bellville", "5 kW hybrid rooftop", "VAN-2", "Pieter", "Q-2204", [["PV6-RED", 22], ["PV6-BLK", 22], ["AC4-3C", 12], ["PNL-550", 6], ["INV-5KW", 1]], ago(14));
  kit(j2, ago(13, 15), { "PNL-550": panels.slice(6, 12), "INV-5KW": invs.slice(1, 2) }); out(j2, ago(12, 7));
  M(ago(12, 11), "extra", "PV6-RED", 3, "WH", "JOB:J-1002", { job: "J-1002", van: "VAN-2", installer: "Pieter", reason: "Longer run to DB board than quoted" });
  M(ago(12, 11), "extra", "PV6-BLK", 3, "WH", "JOB:J-1002", { job: "J-1002", van: "VAN-2", installer: "Pieter", reason: "Longer run to DB board than quoted" });
  close(j2, ago(10, 16), { "PV6-RED": 2, "PV6-BLK": 2, "AC4-3C": 2 }, {}, { "PV6-RED": 26, "PV6-BLK": 26, "AC4-3C": 12, "PNL-550": 6, "INV-5KW": 1 });

  var j3 = job("J-1003", "Jacobs, Kuils River", "8 kW hybrid rooftop", "VAN-1", "Sipho", "Q-2210", [["PV6-RED", 40], ["PV6-BLK", 40], ["RAIL-42", 10], ["PNL-550", 10], ["MC4", 6]], ago(6));
  kit(j3, ago(5, 15), { "PNL-550": panels.slice(12, 22) }); out(j3, ago(4, 7));

  var j4 = job("J-1004", "Van Wyk, Brackenfell", "Battery add-on", "VAN-2", "Pieter", "Q-2213", [["AC4-3C", 15], ["FUSE-DC", 4]], ago(2));
  kit(j4, ago(1, 15), {});

  job("J-1005", "Daniels, Parow", "3 kW grid-tie", "VAN-1", "Sipho", "Q-2219", [["PV6-RED", 25], ["PV6-BLK", 25], ["PNL-550", 2], ["INV-5KW", 1]], ago(0));

  var B = C.balances(d.Moves);
  C.countMoves("VAN-1", { "MC4": 6, "TIES-100": 2, "LUG-16": 12, "FUSE-DC": 4 }, B, I, ago(9, 16), "Van count").forEach(function (m) { m.id = "demo" + (++k); m.by = "sipho"; d.Moves.push(m); });
  C.countMoves("VAN-2", { "MC4": 8, "TIES-100": 2, "LUG-16": 16, "FUSE-DC": 6 }, B, I, ago(9, 16), "Van count").forEach(function (m) { m.id = "demo" + (++k); m.by = "sipho"; d.Moves.push(m); });
  B = C.balances(d.Moves);
  C.countMoves("WH", { "LUG-16": C.bal(B, "WH", "LUG-16") - 5 }, B, I, ago(7, 16), "Shelf count").forEach(function (m) { m.id = "demo" + (++k); m.by = "lebo"; d.Moves.push(m); });
  // a shelf count by the User, waiting for a manager to approve
  B = C.balances(d.Moves);
  var cl = C.countLines("WH", { "PV6-RED": C.bal(B, "WH", "PV6-RED") - 6, "PV6-BLK": C.bal(B, "WH", "PV6-BLK"), "MC4": C.bal(B, "WH", "MC4") - 2, "RAIL-42": C.bal(B, "WH", "RAIL-42") }, B, I);
  d.Counts.push({ id: "CNT-demo1", place: "WH", ts: ago(0, 9), by: "sipho", status: "pending", lines: JSON.stringify(cl),
    value: C.round2(cl.reduce(function (s2, l) { return s2 + l.value; }, 0)), note: "Drum 1 measured by hand, label torn" });
  return d;
}

/* ===================== start ===================== */
(function start() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      // a newer version was installed: load it once, unless the person is mid-way through a form
      if (hadController && !reloaded && !S.busy && !Q.length) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) { reg.update(); }).catch(function () {});
  }
  var code = new URLSearchParams(location.search).get("c");
  if (code) { S.pendingCode = code; history.replaceState(null, "", location.pathname); }
  render();
  reload().then(openPendingCode);
})();
// A sticker scanned with the normal camera opens the app on that item, after sign-in if needed.
function openPendingCode() {
  if (!S.pendingCode || !cfg.token || !cfg.user || cfg.user.mustChange) return;
  var c = S.pendingCode; S.pendingCode = null; handleCode(c);
}
