/*
 * Stock Counter - core logic.
 * Pure functions only (no screen, no network), so the maths can be tested on its own.
 *
 * The ledger idea: stock is never edited. Every movement is a row with a FROM and a TO place.
 * The amount in any place = everything that came in minus everything that went out.
 *
 * Places:
 *   SUPPLIER   where received stock comes from
 *   WH         the warehouse
 *   VAN-x      a van (small-parts kit only)
 *   JOB:J-1001 stock that is out on a job
 *   SCRAP      unusable offcuts that came back
 *   USED       installed on a job, or used from a van kit
 *   LOSS       not returned / count shortages
 */
(function (root) {
  "use strict";

  var EPS = 1e-9;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(num(n) * 100) / 100; }

  /** Amount of each item in each place. Returns { place: { sku: qty } } */
  function balances(moves) {
    var B = {};
    function add(loc, sku, q) {
      if (!loc) return;
      if (!B[loc]) B[loc] = {};
      B[loc][sku] = round2((B[loc][sku] || 0) + q);
    }
    (moves || []).forEach(function (m) {
      var q = num(m.qty);
      add(m.from, m.sku, -q);
      add(m.to, m.sku, q);
    });
    return B;
  }

  function bal(B, loc, sku) { return (B[loc] && B[loc][sku]) || 0; }

  /** Kit quantity = quoted + allowance. Cable rounds up to whole metres. */
  function kitDefault(item, quoted) {
    var q = num(quoted);
    if (!item || item.uom !== "m") return q;
    var pct = item.allowancePct === "" || item.allowancePct == null ? 10 : num(item.allowancePct);
    return Math.ceil(q * (1 + pct / 100));
  }

  /**
   * One row per item on a job:
   * quoted, issued (kit + extras), returned, scrap, used, missing, outstanding (still out).
   */
  function jobSummary(jobNo, lines, moves, items) {
    var loc = "JOB:" + jobNo;
    var rows = {};
    function row(sku) {
      if (!rows[sku]) rows[sku] = { sku: sku, quoted: 0, issued: 0, extra: 0, returned: 0, scrap: 0, used: 0, missing: 0 };
      return rows[sku];
    }
    (lines || []).forEach(function (l) { if (l.job === jobNo) row(l.sku).quoted += num(l.quoted); });
    (moves || []).forEach(function (m) {
      var q = num(m.qty);
      if (m.to === loc) {
        var r = row(m.sku);
        r.issued += q;
        if (m.type === "extra") r.extra += q;
      } else if (m.from === loc) {
        var r2 = row(m.sku);
        if (m.to === "WH") r2.returned += q;
        else if (m.to === "SCRAP") r2.scrap += q;
        else if (m.to === "USED") r2.used += q;
        else if (m.to === "LOSS") r2.missing += q;
      }
    });
    return Object.keys(rows).sort().map(function (sku) {
      var r = rows[sku];
      ["quoted", "issued", "extra", "returned", "scrap", "used", "missing"].forEach(function (k) { r[k] = round2(r[k]); });
      r.outstanding = round2(r.issued - r.returned - r.scrap - r.used - r.missing);
      r.cost = num(items && items[sku] && items[sku].cost);
      return r;
    });
  }

  /**
   * Closing a job. usedBySku = what the installer says was installed.
   * Anything still out after returns, scrap and used = missing.
   * Returns { moves, missingValue, problems }.
   */
  function closeJob(job, summary, usedBySku, ts) {
    var out = [], missingValue = 0, problems = [];
    summary.forEach(function (r) {
      if (r.outstanding <= EPS) return;
      var raw = usedBySku[r.sku];
      if (raw === undefined || raw === null || raw === "") { problems.push(r.sku); return; }
      var used = Math.max(0, Math.min(r.outstanding, num(raw)));
      var missing = round2(r.outstanding - used);
      var base = { ts: ts, sku: r.sku, from: "JOB:" + job.no, job: job.no, van: job.van, installer: job.installer };
      if (used > EPS) out.push(Object.assign({}, base, { type: "used", qty: round2(used), to: "USED", value: round2(used * r.cost) }));
      if (missing > EPS) {
        out.push(Object.assign({}, base, { type: "missing", qty: missing, to: "LOSS", value: round2(missing * r.cost) }));
        missingValue += missing * r.cost;
      }
    });
    return { moves: out, missingValue: round2(missingValue), problems: problems };
  }

  /** Moving-average landed cost after a receipt. */
  function newAverageCost(oldQty, oldCost, inQty, inCost) {
    oldQty = Math.max(0, num(oldQty));
    var total = oldQty + num(inQty);
    if (total <= EPS) return round2(inCost);
    return round2((oldQty * num(oldCost) + num(inQty) * num(inCost)) / total);
  }

  /** Total on hand of one item across warehouse, vans and open jobs. */
  function onHand(B, sku) {
    var t = 0;
    Object.keys(B).forEach(function (loc) {
      if (loc === "SUPPLIER" || loc === "USED" || loc === "LOSS" || loc === "SCRAP") return;
      t += Math.max(0, bal(B, loc, sku));
    });
    return round2(t);
  }

  /** Losses (not returned + count shortages) in the last `days`, grouped. */
  function losses(moves, days, now) {
    var since = (now || Date.now()) - days * 864e5;
    var res = { total: 0, byInstaller: {}, byVan: {}, rows: [] };
    (moves || []).forEach(function (m) {
      var isLoss = m.to === "LOSS";
      var isGain = m.from === "LOSS";
      if (!isLoss && !isGain) return;
      if (new Date(m.ts).getTime() < since) return;
      var v = num(m.value) * (isGain ? -1 : 1);
      res.total += v;
      var who = m.installer || (m.from === "WH" || m.to === "WH" ? "Warehouse count" : "Van count");
      var van = m.van || (m.from === "WH" || m.to === "WH" ? "Warehouse" : "");
      res.byInstaller[who] = round2((res.byInstaller[who] || 0) + v);
      if (van) res.byVan[van] = round2((res.byVan[van] || 0) + v);
      res.rows.push(m);
    });
    res.total = round2(res.total);
    return res;
  }

  /** Items on a job that used more than the quote by more than `tolPct`. */
  function overQuote(summary, tolPct) {
    var tol = tolPct == null ? 10 : num(tolPct);
    return summary.filter(function (r) {
      var used = r.used + r.missing; // not returned counts as consumed
      return r.quoted > EPS && used > r.quoted * (1 + tol / 100) + EPS;
    }).map(function (r) {
      return { sku: r.sku, quoted: r.quoted, consumed: round2(r.used + r.missing), overPct: round2(((r.used + r.missing) / r.quoted - 1) * 100) };
    });
  }

  /** Count result -> adjustment moves. place = "WH" or a van id. */
  function countMoves(place, counts, B, items, ts, kind) {
    var out = [];
    Object.keys(counts).forEach(function (sku) {
      var raw = counts[sku];
      if (raw === "" || raw == null) return;
      var diff = round2(num(raw) - bal(B, place, sku));
      if (Math.abs(diff) <= EPS) return;
      var cost = num(items[sku] && items[sku].cost);
      var isVan = place !== "WH";
      if (diff < 0) {
        // Van kit shortfall = parts used on jobs. Warehouse shortfall = loss.
        out.push({ ts: ts, type: isVan ? "kituse" : "countshort", sku: sku, qty: -diff, from: place, to: isVan ? "USED" : "LOSS",
          van: isVan ? place : "", value: round2(-diff * cost), reason: kind || "" });
      } else {
        out.push({ ts: ts, type: "countover", sku: sku, qty: diff, from: "LOSS", to: place,
          van: isVan ? place : "", value: round2(diff * cost), reason: kind || "" });
      }
    });
    return out;
  }

  /**
   * A scanned value can be a plain code ("GS-0001"), a link our labels carry
   * ("https://site/?c=GS-0001"), or a factory barcode. Returns the code in capitals.
   */
  function parseScan(text) {
    var t = String(text || "").trim();
    var m = t.match(/[?&#]c=([^&#\s]+)/i);
    if (m) t = decodeURIComponent(m[1]);
    return t.toUpperCase();
  }

  function nextNumber(ids, prefix, pad) {
    var max = 0;
    (ids || []).forEach(function (id) {
      var s = String(id);
      if (s.indexOf(prefix) !== 0) return;
      var n = parseInt(s.slice(prefix.length), 10);
      if (n > max) max = n;
    });
    var next = String(max + 1);
    while (next.length < (pad || 0)) next = "0" + next;
    return prefix + next;
  }

  var Core = {
    balances: balances, bal: bal, kitDefault: kitDefault, jobSummary: jobSummary, closeJob: closeJob,
    newAverageCost: newAverageCost, onHand: onHand, losses: losses, overQuote: overQuote,
    countMoves: countMoves, parseScan: parseScan, nextNumber: nextNumber, round2: round2
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.Core = Core;
})(this);
