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
var cfg = Object.assign({ mode: null, url: "", key: "", name: "", site: "" }, LS.get("sc_cfg", {}));
function saveCfg() { LS.set("sc_cfg", cfg); }
function siteUrl() { return (cfg.site || (location.origin + location.pathname)).replace(/\?.*$/, ""); }

/* ===================== data ===================== */
var TABS = ["Items", "Jobs", "Lines", "Moves", "Labels", "Vans", "VanKit"];
var D = {}; TABS.forEach(function (t) { D[t] = []; });
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
function setData(data) { TABS.forEach(function (t) { D[t] = (data && data[t]) || []; }); derive(); }

/* ===================== backends ===================== */
var demo = {
  load: function () {
    var d = LS.get("sc_demo", null);
    if (!d) { d = seedDemo(); LS.set("sc_demo", d); }
    return Promise.resolve(JSON.parse(JSON.stringify(d)));
  },
  send: function (ops) {
    var d = LS.get("sc_demo", null) || seedDemo();
    applyOpsLocal(d, ops);
    LS.set("sc_demo", d);
    return Promise.resolve(JSON.parse(JSON.stringify(d)));
  }
};
var KEYS = { Items: "sku", Jobs: "no", Lines: "id", Labels: "code", Vans: "id", VanKit: "sku" };
// Same rules as Code.gs, for demo mode.
function applyOpsLocal(d, ops) {
  ops.forEach(function (op) {
    var rows = op.rows || [];
    d[op.sheet] = d[op.sheet] || [];
    var list = d[op.sheet];
    if (op.op === "append") {
      var have = {}; list.forEach(function (r) { have[r.id] = 1; });
      rows.forEach(function (r) { if (!have[r.id]) list.push(r); });
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
function fetchJSON(url, opt) {
  return fetch(url, opt).then(function (res) { return res.text(); }).then(function (t) {
    var j;
    try { j = JSON.parse(t); } catch (e) { throw new Error("The Google Sheet didn't answer properly. Check the web app link in More → Settings."); }
    if (!j.ok) throw new Error(j.error || "Save failed.");
    return j.data;
  }, function () { throw new Error("No connection to the Google Sheet. Check signal and try again."); });
}
var api = {
  load: function () {
    if (cfg.mode === "demo") return demo.load();
    return fetchJSON(cfg.url + (cfg.url.indexOf("?") < 0 ? "?" : "&") + "key=" + encodeURIComponent(cfg.key));
  },
  send: function (ops) {
    if (cfg.mode === "demo") return demo.send(ops);
    return fetchJSON(cfg.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: cfg.key, ops: ops }) });
  }
};

/* ===================== helpers ===================== */
var $ = function (s) { return document.querySelector(s); };
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
function R(v) { return "R " + Math.round(n(v)).toLocaleString("en-ZA"); }
function q(v, sku) { var u = X.items[sku] && X.items[sku].uom; var s = (Math.round(n(v) * 100) / 100).toLocaleString("en-ZA", { maximumFractionDigits: 2 }); return u === "m" ? s + " m" : s; }
function cost(sku) { return n(X.items[sku] && X.items[sku].cost); }
function nameOf(sku) { return (X.items[sku] && X.items[sku].name) || sku; }
function vanName(id) { var v = D.Vans.find(function (x) { return x.id === id; }); return v ? v.name : (id || ""); }
function isSerial(sku) { return X.items[sku] && X.items[sku].track === "serial"; }
function dshort(s) { return s ? new Date(s).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : ""; }
function now() { return new Date().toISOString(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function mv(type, sku, qty, from, to, extra) {
  return Object.assign({ id: uid(), ts: now(), type: type, sku: sku, qty: C.round2(qty), from: from, to: to, by: cfg.name || "",
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
var STATUS = { quoted: "Quoted", kitted: "Ready for van", out: "On site", closed: "Closed" };

/* ===================== screen state ===================== */
var S = { tab: "jobs", sub: null, job: null, f: {}, msg: null, busy: false, scanFor: null, loading: true };
function flash(k, t) { S.msg = { k: k, t: t }; render(); }
function msgHtml() { return S.msg ? '<div class="msg ' + S.msg.k + '" role="status">' + esc(S.msg.t) + "</div>" : ""; }
function go(tab, extra) {
  if (tab !== "scan" && !(S.scanFor && tab === "jobs")) stopCam();
  S.tab = tab; S.sub = null; S.job = null; S.msg = null; S.f = {};
  Object.assign(S, extra || {});
  render(); window.scrollTo(0, 0);
}
function setStatus(k, t) { $("#dot").className = "dot " + (k || ""); $("#statusText").textContent = t; }

function save(ops, okMsg, after) {
  S.busy = true; render();
  return api.send(ops).then(function (data) {
    setData(data); S.msg = { k: "ok", t: okMsg };
    if (after) after();
    setStatus("ok", cfg.mode === "demo" ? "Demo" : "Saved " + new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }));
  }).catch(function (e) {
    S.msg = { k: "err", t: e.message };
  }).then(function () { S.busy = false; render(); });
}
function reload() {
  if (!cfg.mode) { S.loading = false; setStatus("", "Not connected"); render(); return Promise.resolve(); }
  setStatus("", "Loading…");
  return api.load().then(function (data) {
    setData(data); S.loading = false;
    setStatus("ok", cfg.mode === "demo" ? "Demo" : "Up to date");
    render();
  }).catch(function (e) {
    S.loading = false; setStatus("err", "Offline");
    S.msg = { k: "err", t: e.message }; render();
  });
}

/* ===================== render ===================== */
function render() {
  document.querySelectorAll("nav.tabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === S.tab && b.dataset.tab !== "scan"); });
  $("#demoBar").hidden = cfg.mode !== "demo";
  var v = $("#view");
  var html;
  if (!cfg.mode && !(S.tab === "more" && S.sub === "settings")) html = vWelcome();
  else if (S.loading) html = '<p class="muted">Loading stock…</p>';
  else html = ({ jobs: vJobs, stock: vStock, scan: vScan, counts: vCounts, more: vMore })[S.tab]();
  // keep what the person was typing
  var a = document.activeElement, id = a && a.id, pos = null;
  try { pos = a && a.selectionStart; } catch (e) {}
  v.innerHTML = html;
  patchReturn();
  if (id) { var el = document.getElementById(id); if (el && el.tagName !== "BUTTON") { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) {} } }
}

function vWelcome() {
  return '<section class="panel"><h2>Welcome</h2>' +
    '<p>Every metre that leaves the store is tied to a job, and has to come back or be explained.</p>' +
    '<button class="btn wide" data-action="startDemo">Try it with example data</button>' +
    '<button class="btn ghost wide" data-action="startLive">Connect our Google Sheet</button>' +
    '<p class="small muted">Demo data stays on this phone only. You can switch any time in More → Settings.</p></section>';
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
  return '<div class="spread"><h2>Jobs</h2><button class="btn small" data-action="newJob">+ New job</button></div>' + msgHtml() +
    sec("To kit", groups.quoted, "Pick these into a crate") +
    sec("Ready for van", groups.kitted, "Scan the crate when collected") +
    sec("On site", groups.out, "Check the crate when it comes back") +
    sec("Closed", groups.closed, "Latest 10", 10) +
    (D.Jobs.length ? "" : '<p class="muted">No jobs yet. Start with + New job and copy the materials from the quote.</p>');
}

function vJobForm() {
  var f = S.f.nj || (S.f.nj = { client: "", type: "", van: "", installer: "", quoteRef: "", lines: [{ sku: "", quoted: "" }] });
  var items = D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var lineRows = f.lines.map(function (l, i) {
    return '<div class="row"><label class="f" style="flex:3 1 180px">Item<select id="nl_sku_' + i + '" data-bind="nj.lines.' + i + '.sku">' +
      '<option value="">Choose…</option>' + items.map(function (it) { return '<option value="' + esc(it.sku) + '"' + (it.sku === l.sku ? " selected" : "") + ">" + esc(it.name) + "</option>"; }).join("") +
      '</select></label><label class="f" style="flex:1 1 90px">Quoted' + (l.sku && X.items[l.sku] && X.items[l.sku].uom === "m" ? " (m)" : "") +
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
  if (j.status === "quoted") body = vKit(j, sum);
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
    form += '<div class="row"><label class="f">Quantity' + (it.uom === "m" ? " (m)" : "") + '<input class="num" id="rc_qty" type="number" inputmode="decimal" min="0" step="any" data-bind="qty" value="' + esc(serial ? sers.length || "" : f.qty || "") + '"' + (serial ? " readonly" : "") + "></label>" +
      '<label class="f">Landed cost per ' + (it.uom === "m" ? "metre" : "unit") + ' (R)<input class="num" id="rc_cost" type="number" inputmode="decimal" min="0" step="any" data-bind="cost" value="' + esc(f.cost != null ? f.cost : (n(it.cost) || "")) + '"></label></div>' +
      '<label class="f">Shipment or invoice ref<input id="rc_ref" data-bind="ref" value="' + esc(f.ref || "") + '" placeholder="e.g. Container MSKU 12345"></label>' +
      '<p class="tiny muted">Landed cost = supplier price + freight + duty + clearing, per unit.</p>' +
      (serial ? '<div class="serials">' + sers.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + '</div><button class="btn ghost small" data-action="scanSerials" data-sku="' + esc(it.sku) + '" data-need="999">Scan serial numbers (' + sers.length + ")</button>" : "");
  } else if (mode === "extra") {
    var jobs = D.Jobs.filter(function (j) { return j.status === "out" || j.status === "kitted"; });
    form += '<div class="row"><label class="f">Quantity' + (it.uom === "m" ? " (m)" : "") + '<input class="num" id="ex_qty" type="number" inputmode="decimal" min="0" step="any" data-bind="qty" value="' + esc(f.qty || "") + '"></label>' +
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
  var vanIds = X.vans.map(function (v) { return v.id; });
  var whVal = 0, vanVal = 0, jobVal = 0;
  var rows = D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (it) {
    var wh = bal("WH", it.sku), vv = 0, jb = 0;
    vanIds.forEach(function (v) { vv += bal(v, it.sku); });
    Object.keys(X.B).forEach(function (l) { if (l.indexOf("JOB:") === 0) jb += bal(l, it.sku); });
    whVal += wh * cost(it.sku); vanVal += vv * cost(it.sku); jobVal += jb * cost(it.sku);
    var low = n(it.reorder) > 0 && wh < n(it.reorder);
    return "<tr><td>" + esc(it.name) + '<div class="tiny muted mono">' + esc(it.sku) + "</div></td>" +
      '<td class="n">' + q(wh, it.sku) + (low ? ' <span class="pill p-kitted">Order</span>' : "") + (wh < -1e-9 ? ' <span class="pill p-bad">Check</span>' : "") + "</td>" +
      '<td class="n">' + q(vv, it.sku) + '</td><td class="n">' + q(jb, it.sku) + '</td><td class="n">' + R((wh + vv + jb) * cost(it.sku)) + "</td></tr>";
  }).join("");
  var L = C.losses(D.Moves, 30);
  function ranked(o, nm) {
    var e = Object.keys(o).map(function (k) { return [k, o[k]]; }).filter(function (x) { return Math.abs(x[1]) > 0.004; }).sort(function (a, b) { return b[1] - a[1]; });
    return e.length ? e.map(function (x) { return "<tr><td>" + esc(nm(x[0])) + '</td><td class="n">' + R(x[1]) + "</td></tr>"; }).join("") : '<tr><td class="muted">Nothing missing</td><td></td></tr>';
  }
  var since = Date.now() - 30 * 864e5;
  var overJobs = D.Jobs.filter(function (j) { return j.status === "closed" && new Date(j.closedAt).getTime() >= since; }).map(function (j) {
    return { j: j, f: C.overQuote(C.jobSummary(j.no, D.Lines, D.Moves, X.items), 10) };
  }).filter(function (x) { return x.f.length; });
  return "<h2>Stock</h2>" + msgHtml() +
    '<div class="kpis"><div class="kpi"><div class="l">Missing, last 30 days</div><div class="v ' + (L.total > 0 ? "bad" : "") + '">' + R(L.total) + "</div></div>" +
    '<div class="kpi"><div class="l">In store</div><div class="v">' + R(whVal) + '</div></div><div class="kpi"><div class="l">In vans</div><div class="v">' + R(vanVal) + "</div></div>" +
    '<div class="kpi"><div class="l">Out on jobs</div><div class="v">' + R(jobVal) + "</div></div></div>" +
    '<section class="panel"><h3>Where the missing stock sits (30 days)</h3><div class="row" style="align-items:flex-start">' +
    '<div class="tablewrap" style="flex:1 1 220px"><table><thead><tr><th>Installer</th><th class="n">Value</th></tr></thead><tbody>' + ranked(L.byInstaller, function (x) { return x; }) + "</tbody></table></div>" +
    '<div class="tablewrap" style="flex:1 1 220px"><table><thead><tr><th>Van / place</th><th class="n">Value</th></tr></thead><tbody>' + ranked(L.byVan, vanName) + "</tbody></table></div></div>" +
    '<p class="tiny muted">One bad job is noise. The same name at the top every month is a pattern worth a conversation.</p></section>' +
    (overJobs.length ? '<section class="panel"><h3>Jobs that used more than quoted</h3><div class="tablewrap"><table><thead><tr><th>Job</th><th>Item</th><th class="n">Over</th></tr></thead><tbody>' +
      overJobs.map(function (x) { return x.f.map(function (f) { return "<tr><td>" + esc(x.j.no) + '<div class="tiny muted">' + esc(x.j.type) + "</div></td><td>" + esc(nameOf(f.sku)) + '</td><td class="n">+' + Math.round(f.overPct) + "%</td></tr>"; }).join(""); }).join("") +
      '</tbody></table></div><p class="tiny muted">If the same job type keeps going over, the quote template is too low and the business is losing margin.</p></section>' : "") +
    '<section class="panel"><h3>Stock on hand</h3><div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">Store</th><th class="n">Vans</th><th class="n">Jobs</th><th class="n">Value</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    '<p class="tiny muted">Value uses the average landed cost of each item.</p></section>';
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
  Object.keys(S.f.cnt || {}).forEach(function (sku) {
    var cells = countCells(place, sku), a = document.getElementById("cdiff_" + sku), b = document.getElementById("ctop_" + sku);
    if (a) a.innerHTML = cells[0]; if (b) b.innerHTML = cells[1];
  });
}
function vCounts() {
  var place = S.f.place || "WH";
  var c = S.f.cnt || (S.f.cnt = {});
  var isVan = place !== "WH";
  var skus = isVan ? X.kit.map(function (k) { return k.sku; }) : D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) { return i.sku; });
  var last = null;
  D.Moves.forEach(function (m) { if ((m.type === "countshort" || m.type === "countover" || m.type === "kituse") && (m.from === place || m.to === place)) last = m.ts; });
  var rows = skus.map(function (sku) {
    var raw = c[sku];
    return "<tr><td>" + esc(nameOf(sku)) + '</td><td class="n">' + q(bal(place, sku), sku) + '</td><td class="n" style="min-width:90px"><input class="num" id="cnt_' + esc(sku) + '" type="number" inputmode="decimal" min="0" step="any" value="' + esc(raw == null ? "" : raw) +
      '" data-bind="cnt.' + esc(sku) + '" data-live="1" aria-label="Counted ' + esc(nameOf(sku)) + '"></td><td class="n" id="cdiff_' + esc(sku) + '">' + countCells(place, sku)[0] + "</td>" +
      (isVan ? '<td class="n" id="ctop_' + esc(sku) + '">' + countCells(place, sku)[1] + "</td>" : "") + "</tr>";
  }).join("");
  return '<h2>Counts</h2><section class="panel"><label class="f">What are you counting?<select id="cnt_place" data-bind="place" data-rerender="1" data-reset="cnt">' +
    '<option value="WH"' + (place === "WH" ? " selected" : "") + ">Warehouse shelves</option>" + X.vans.map(function (v) { return '<option value="' + esc(v.id) + '"' + (v.id === place ? " selected" : "") + ">" + esc(v.name) + " kit</option>"; }).join("") + "</select></label>" +
    '<p class="small muted">Last counted: ' + (last ? dshort(last) : "never") + ". " + (isVan ? "Count weekly. Shortfalls are booked as parts used on jobs; then top up to target." : "Count cable and expensive items weekly, the rest monthly. Leave a line blank to skip it.") + "</p>" +
    (skus.length ? '<div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">System</th><th class="n">Counted</th><th class="n">Diff</th>' + (isVan ? '<th class="n">Top up</th>' : "") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" : '<p class="muted">No van kit list yet. Set it up in More → Vans.</p>') +
    msgHtml() + '<button class="btn wide" data-action="saveCount"' + (S.busy || !skus.length ? " disabled" : "") + ">Save count</button></section>";
}

/* ---------- More ---------- */
function vMore() {
  if (S.sub === "items") return vItems();
  if (S.sub === "labels") return vLabels();
  if (S.sub === "vans") return vVans();
  if (S.sub === "settings") return vSettings();
  function item(sub, t, d) { return '<button class="card" data-action="sub" data-sub="' + sub + '"><div><h3>' + t + '</h3><div class="small muted">' + d + "</div></div><span>›</span></button>"; }
  return '<h2>More</h2><div class="list">' + item("labels", "Stickers", "Make QR stickers for drums, bins and shelves") + item("items", "Items", "Products, units, reorder levels") +
    item("vans", "Vans and van kit", "Vans and the small parts each one carries") + item("settings", "Settings", "Google Sheet connection, your name") + "</div>";
}
function backMore() { return '<div class="row"><button class="btn ghost small" data-action="sub" data-sub="">← More</button></div>'; }

function vItems() {
  var f = S.f.it || (S.f.it = { uom: "m", track: "qty", allowancePct: "10" });
  var list = D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) {
    return '<button class="card" data-action="editItem" data-sku="' + esc(i.sku) + '"><div><div>' + esc(i.name) + '</div><div class="tiny muted mono">' + esc(i.sku) + " · " + (i.uom === "m" ? "metres" : "units") + (i.track === "serial" ? " · serial" : "") + '</div></div><span class="mono small">' + R(i.cost) + (i.uom === "m" ? "/m" : "") + "</span></button>";
  }).join("");
  return backMore() + "<h2>Items</h2>" +
    '<section class="panel"><h3>' + (f.editing ? "Edit " + esc(f.sku) : "Add an item") + '</h3><div class="row">' +
    '<label class="f">Item code<input class="code" id="it_sku" data-bind="it.sku" value="' + esc(f.sku || "") + '"' + (f.editing ? " readonly" : "") + ' placeholder="PV6-RED"></label>' +
    '<label class="f" style="flex:2 1 200px">Description<input id="it_name" data-bind="it.name" value="' + esc(f.name || "") + '" placeholder="PV cable 6 mm² red"></label></div><div class="row">' +
    '<label class="f">Counted in<select id="it_uom" data-bind="it.uom"><option value="m"' + (f.uom === "m" ? " selected" : "") + '>Metres</option><option value="ea"' + (f.uom !== "m" ? " selected" : "") + ">Units</option></select></label>" +
    '<label class="f">Tracked by<select id="it_track" data-bind="it.track"><option value="qty">Quantity</option><option value="serial"' + (f.track === "serial" ? " selected" : "") + ">Serial number</option></select></label>" +
    '<label class="f">Order when store has less than<input class="num" id="it_reorder" type="number" min="0" data-bind="it.reorder" value="' + esc(f.reorder || "") + '"></label>' +
    '<label class="f">Cable allowance %<input class="num" id="it_allow" type="number" min="0" data-bind="it.allowancePct" value="' + esc(f.allowancePct == null ? "" : f.allowancePct) + '"></label></div>' +
    msgHtml() + '<div class="row"><button class="btn" data-action="saveItem"' + (S.busy ? " disabled" : "") + ">" + (f.editing ? "Save" : "Add item") + "</button>" + (f.editing ? '<button class="btn ghost" data-action="sub" data-sub="items">Cancel</button>' : "") + "</div>" +
    '<p class="tiny muted">Cost is set automatically from the landed cost when you receive stock.</p></section><div class="list">' + list + "</div>";
}

function vLabels() {
  var f = S.f.lb || (S.f.lb = {});
  var cards = D.Labels.slice().sort(function (a, b) { return a.code.localeCompare(b.code); }).map(function (l) {
    return '<div class="lbl"><img src="' + qrImg(labelLink(l.code), 4) + '" alt="QR ' + esc(l.code) + '"><div class="id">' + esc(l.code) + "</div><div>" + esc(nameOf(l.sku)) + '</div><div class="tiny muted">' + esc(l.note) + "</div></div>";
  }).join("");
  return backMore() + '<div class="spread"><h2>Stickers</h2><button class="btn ghost small" data-action="printLabels"' + (D.Labels.length ? "" : " disabled") + ">Print sticker sheet</button></div>" +
    '<section class="panel"><h3>New sticker</h3><p class="small muted">One sticker per drum, roll, box or shelf bin. Panels and inverters use their factory serial barcode instead.</p><div class="row">' +
    '<label class="f">Item<select id="lb_sku" data-bind="lb.sku"><option value="">Choose…</option>' + D.Items.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) { return '<option value="' + esc(i.sku) + '"' + (i.sku === f.sku ? " selected" : "") + ">" + esc(i.name) + "</option>"; }).join("") + "</select></label>" +
    '<label class="f">Where it goes<input id="lb_note" data-bind="lb.note" value="' + esc(f.note || "") + '" placeholder="e.g. Drum 3 · 500 m"></label></div>' +
    msgHtml() + '<button class="btn" data-action="saveLabel"' + (S.busy ? " disabled" : "") + ">Create sticker</button></section>" +
    '<div class="labels">' + (cards || '<p class="muted">No stickers yet.</p>') + "</div>" +
    '<p class="tiny muted">Each sticker holds a link. Pointing the normal phone camera at it opens this app on that item.</p>';
}

function vVans() {
  var f = S.f.vn || (S.f.vn = {});
  var kitT = S.f.kt || (S.f.kt = {});
  D.VanKit.forEach(function (k) { if (kitT[k.sku] === undefined) kitT[k.sku] = String(k.target); });
  var rows = D.Items.filter(function (i) { return i.uom !== "m" && i.track !== "serial"; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) {
    return "<tr><td>" + esc(i.name) + '</td><td class="n" style="min-width:90px"><input class="num" id="kt_' + esc(i.sku) + '" type="number" min="0" data-bind="kt.' + esc(i.sku) + '" value="' + esc(kitT[i.sku] || "") + '" aria-label="Van target ' + esc(i.name) + '"></td></tr>';
  }).join("");
  return backMore() + "<h2>Vans</h2>" +
    '<section class="panel"><h3>Vans</h3>' + X.vans.map(function (v) { return '<div class="spread"><span>' + esc(v.name) + '</span><span class="mono tiny muted">' + esc(v.id) + "</span></div>"; }).join("") +
    '<div class="row"><label class="f">New van name<input id="vn_name" data-bind="vn.name" value="' + esc(f.name || "") + '" placeholder="e.g. Van 3 · Ranger CA 123-456"></label><button class="btn ghost" data-action="saveVan">Add van</button></div></section>' +
    '<section class="panel"><h3>Van kit (same for every van)</h3><p class="small muted">Small parts only. Cable and big items always go out per job. Leave blank to keep an item off the van.</p>' +
    '<div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">Keep in van</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
    msgHtml() + '<button class="btn" data-action="saveKit"' + (S.busy ? " disabled" : "") + ">Save van kit</button></section>";
}

function vSettings() {
  var f = S.f.st || (S.f.st = { url: cfg.url, key: cfg.key, name: cfg.name, site: cfg.site });
  return backMore() + "<h2>Settings</h2>" +
    '<section class="panel"><label class="f">Your name (shown on every movement)<input id="st_name" data-bind="st.name" value="' + esc(f.name || "") + '"></label></section>' +
    '<section class="panel"><h3>Google Sheet</h3><p class="small muted">From the setup guide: the web app link and the secret key.</p>' +
    '<label class="f">Web app link<input id="st_url" data-bind="st.url" value="' + esc(f.url || "") + '" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
    '<label class="f">Secret key<input id="st_key" data-bind="st.key" value="' + esc(f.key || "") + '" autocomplete="off"></label>' +
    '<label class="f">This app\'s web address (for stickers)<input id="st_site" data-bind="st.site" value="' + esc(f.site || "") + '" placeholder="' + esc(location.origin + location.pathname) + '"></label>' +
    msgHtml() + '<button class="btn" data-action="saveSettings"' + (S.busy ? " disabled" : "") + ">Save and connect</button>" +
    '<p class="small">Now using: <b>' + (cfg.mode === "live" ? "Google Sheet" : "Demo data on this phone") + "</b></p></section>" +
    '<section class="panel"><h3>Demo</h3><div class="row"><button class="btn ghost" data-action="useDemo">Use demo data</button><button class="btn ghost" data-action="resetDemo">Reset demo data</button></div></section>';
}

/* ===================== actions ===================== */
function bindValue(path, value) {
  var parts = path.split("."), o = S.f;
  for (var i = 0; i < parts.length - 1; i++) { var p = parts[i]; if (o[p] == null) o[p] = /^\d+$/.test(parts[i + 1]) ? [] : {}; o = o[p]; }
  o[parts[parts.length - 1]] = value;
}

var A = {
  startDemo: function () { cfg.mode = "demo"; cfg.name = cfg.name || "Storeman"; saveCfg(); S.loading = true; render(); reload(); },
  startLive: function () { S.loading = false; go("more", { sub: "settings" }); },
  back: function () { S.sub = null; S.job = null; S.msg = null; S.f = {}; render(); window.scrollTo(0, 0); },
  sub: function (b) { S.sub = b.dataset.sub || null; S.msg = null; S.f = {}; render(); window.scrollTo(0, 0); },
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
    var no = f.no || C.nextNumber(D.Jobs.map(function (j) { return j.no; }), "J-", 4);
    if (!f.no && no === "J-0001") no = "J-1001";
    var job = { no: no, client: f.client, type: f.type || "", van: f.van, installer: f.installer, quoteRef: f.quoteRef || "" };
    if (!f.no) { job.status = "quoted"; job.created = now(); }
    save([{ op: "upsert", sheet: "Jobs", rows: [job] },
          { op: "replaceLines", sheet: "Lines", job: no, rows: lines.map(function (l) { return { id: no + "|" + l.sku, job: no, sku: l.sku, quoted: C.round2(l.quoted) }; }) }],
      (f.no ? "Saved " : "Job " + no + " created. ") + "Next: pick the kit.", function () { S.sub = null; S.job = no; S.f = {}; });
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
    save([{ op: "append", sheet: "Moves", rows: moves }, { op: "upsert", sheet: "Jobs", rows: [{ no: j.no, status: "kitted", kittedAt: now() }] }],
      "Kit recorded. Put the crate label on and wait for the van.", function () { S.f = {}; });
  },
  collected: function () {
    var j = X.jobs[S.job];
    save([{ op: "upsert", sheet: "Jobs", rows: [{ no: j.no, status: "out", outAt: now() }] }], j.no + " is on site. Check the crate when it comes back.", function () { S.f = {}; });
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
    res.moves.forEach(function (m) { m.id = uid(); m.by = cfg.name || ""; });
    save([{ op: "append", sheet: "Moves", rows: moves.concat(res.moves) },
          { op: "upsert", sheet: "Jobs", rows: [{ no: j.no, status: "closed", closedAt: now(), missingValue: res.missingValue, reason: f.reason || "" }] }],
      res.missingValue > 0 ? "Job closed. " + R(res.missingValue) + " recorded as missing." : "Job closed. Everything accounted for.", function () { S.f = {}; });
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
      if (f.cost == null && !(n(it.cost) > 0) || f.cost === "") return flash("err", "Enter the landed cost per " + (it.uom === "m" ? "metre." : "unit."));
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
    var moves = C.countMoves(place, c, X.B, X.items, now(), place === "WH" ? "Shelf count" : "Van count");
    moves.forEach(function (m) { m.id = uid(); m.by = cfg.name || ""; });
    if (!moves.length) { S.f.cnt = {}; return flash("ok", "Count matches the system. Nothing to adjust."); }
    var short = moves.filter(function (m) { return m.type === "countshort"; }).reduce(function (s, m) { return s + n(m.value); }, 0);
    save([{ op: "append", sheet: "Moves", rows: moves }],
      place === "WH" ? (short > 0 ? "Count saved. " + R(short) + " short on the shelves." : "Count saved.") : "Van count saved. Top up to target from Scan.", function () { S.f.cnt = {}; });
  },
  editItem: function (b) { var i = X.items[b.dataset.sku]; S.f.it = Object.assign({ editing: true }, i); S.msg = null; render(); window.scrollTo(0, 0); },
  saveItem: function () {
    var f = S.f.it, sku = String(f.sku || "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_.\-]{0,40}$/.test(sku)) return flash("err", "Item code: letters, numbers and dashes only.");
    if (!f.name) return flash("err", "Add a description.");
    if (!f.editing && (X.items[sku] || X.labels[sku] || X.jobs[sku])) return flash("err", "That code is already used.");
    var row = { sku: sku, name: f.name, uom: f.uom === "m" ? "m" : "ea", track: f.track === "serial" ? "serial" : "qty", reorder: n(f.reorder), allowancePct: f.allowancePct === "" ? "" : n(f.allowancePct) };
    if (!f.editing) row.cost = 0;
    save([{ op: "upsert", sheet: "Items", rows: [row] }], (f.editing ? "Saved " : "Added ") + sku + ".", function () { S.f.it = { uom: "m", track: "qty", allowancePct: "10" }; });
  },
  saveLabel: function () {
    var f = S.f.lb;
    if (!f.sku) return flash("err", "Choose the item.");
    var code = C.nextNumber(D.Labels.map(function (l) { return l.code; }), "GS-", 4);
    save([{ op: "upsert", sheet: "Labels", rows: [{ code: code, sku: f.sku, note: f.note || "" }] }], "Sticker " + code + " created.", function () { S.f.lb = { sku: f.sku }; });
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
    var id = C.nextNumber(D.Vans.map(function (v) { return v.id; }), "VAN-", 0);
    save([{ op: "upsert", sheet: "Vans", rows: [{ id: id, name: f.name }] }], "Van added.", function () { S.f.vn = {}; });
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
  saveSettings: function () {
    var f = S.f.st;
    cfg.name = f.name || "";
    cfg.site = (f.site || "").trim();
    if (!f.url || !f.key) { saveCfg(); return flash("ok", "Name saved. Add the web app link and secret key to connect the Google Sheet."); }
    var url = f.url.trim(), key = f.key.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url)) return flash("err", "The web app link should start with https://script.google.com/macros/s/ and end with /exec.");
    S.busy = true; S.msg = { k: "info", t: "Connecting…" }; render();
    fetchJSON(url + "?key=" + encodeURIComponent(key)).then(function (data) {
      cfg.mode = "live"; cfg.url = url; cfg.key = key; saveCfg();
      setData(data); setStatus("ok", "Up to date");
      S.msg = { k: "ok", t: "Connected to the Google Sheet." };
    }).catch(function (e) { S.msg = { k: "err", t: e.message }; }).then(function () { S.busy = false; render(); });
  },
  useDemo: function () { cfg.mode = "demo"; saveCfg(); S.loading = true; reload().then(function () { flash("ok", "Using demo data."); }); },
  resetDemo: function () { LS.set("sc_demo", null); if (cfg.mode === "demo") { S.loading = true; reload().then(function () { flash("ok", "Demo data reset."); }); } else flash("ok", "Demo data reset."); }
};

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
  if (!sku) { S.tab = "scan"; S.f = { code: code }; return flash("err", code + " isn't a sticker, job or item in the system. Check the code, or create the sticker in More → Stickers."); }
  var keep = S.f.mode === "extra" ? { mode: "extra", job: S.f.job } : {};
  S.tab = "scan"; S.f = Object.assign({ sku: sku, label: X.labels[code] ? code : "", code: "" }, keep); S.msg = null; render();
}

/* ===================== events ===================== */
document.addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
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
  bindValue(t.dataset.bind, t.value);
  if (t.tagName === "SELECT") { if (t.dataset.reset) S.f[t.dataset.reset] = {}; render(); return; }
  if (t.dataset.live) { if (S.tab === "counts") patchCounts(); else patchReturn(); }
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  if (e.target.id === "sc_code") { e.preventDefault(); A.lookup(); }
  if (e.target.id === "ser_manual") { e.preventDefault(); A.addSerial(); }
});
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && cfg.mode === "live" && !S.busy) reload(); });

/* ===================== demo data ===================== */
function seedDemo() {
  var d = { Items: [], Jobs: [], Lines: [], Moves: [], Labels: [], Vans: [], VanKit: [] };
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
    var m = Object.assign({ id: "demo" + (++k), ts: ts, type: type, sku: sku, qty: qty, from: from, to: to, by: "Storeman", value: C.round2(qty * I[sku].cost) }, extra || {});
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
    res.moves.forEach(function (m) { m.id = "demo" + (++k); m.by = "Storeman"; d.Moves.push(m); });
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
  C.countMoves("VAN-1", { "MC4": 6, "TIES-100": 2, "LUG-16": 12, "FUSE-DC": 4 }, B, I, ago(9, 16), "Van count").forEach(function (m) { m.id = "demo" + (++k); m.by = "Storeman"; d.Moves.push(m); });
  C.countMoves("VAN-2", { "MC4": 8, "TIES-100": 2, "LUG-16": 16, "FUSE-DC": 6 }, B, I, ago(9, 16), "Van count").forEach(function (m) { m.id = "demo" + (++k); m.by = "Storeman"; d.Moves.push(m); });
  B = C.balances(d.Moves);
  C.countMoves("WH", { "LUG-16": C.bal(B, "WH", "LUG-16") - 5 }, B, I, ago(7, 16), "Shelf count").forEach(function (m) { m.id = "demo" + (++k); m.by = "Storeman"; d.Moves.push(m); });
  return d;
}

/* ===================== start ===================== */
(function start() {
  render();
  var params = new URLSearchParams(location.search);
  var code = params.get("c");
  reload().then(function () {
    if (code && cfg.mode) { history.replaceState(null, "", location.pathname); handleCode(code); }
  });
})();
