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
    // round first: 50 x 1.1 is 55.000000000000007 in computer maths and must not become 56
    return Math.ceil(round2(q * (1 + pct / 100)) - 1e-9);
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
      if (m.type === "reverse") {
        // A correction undoes an earlier movement, so it subtracts from that column.
        if (m.from !== loc && m.to !== loc) return;
        var rr = row(m.sku);
        if (m.reverses === "return") rr.returned -= q;
        else if (m.reverses === "scrap") rr.scrap -= q;
        else if (m.reverses === "extra") { rr.issued -= q; rr.extra -= q; }
        return;
      }
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
      var who = m.installer || (m.from === "WH" || m.to === "WH" ? "Store counts & write-offs" : "Van count");
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

  /** One line per counted item: what the system says, what was counted, the difference and its value. */
  function countLines(place, counts, B, items) {
    return Object.keys(counts).filter(function (sku) { var raw = counts[sku]; return raw !== "" && raw != null; }).sort().map(function (sku) {
      var system = round2(bal(B, place, sku)), counted = round2(num(counts[sku])), diff = round2(counted - system);
      return { sku: sku, system: system, counted: counted, diff: diff, value: round2(diff * num(items[sku] && items[sku].cost)) };
    });
  }

  /** Count lines -> adjustment moves. place = "WH" or a van id. Van shortfalls are parts used on jobs. */
  function linesToMoves(place, lines, items, ts, reason, ref) {
    var out = [], isVan = place !== "WH";
    lines.forEach(function (l) {
      var diff = round2(l.diff);
      if (Math.abs(diff) <= EPS) return;
      var cost = num(items[l.sku] && items[l.sku].cost);
      if (diff < 0) {
        out.push({ ts: ts, type: isVan ? "kituse" : "countshort", sku: l.sku, qty: -diff, from: place, to: isVan ? "USED" : "LOSS",
          van: isVan ? place : "", value: round2(-diff * cost), reason: reason || "", ref: ref || "" });
      } else {
        out.push({ ts: ts, type: "countover", sku: l.sku, qty: diff, from: "LOSS", to: place,
          van: isVan ? place : "", value: round2(diff * cost), reason: reason || "", ref: ref || "" });
      }
    });
    return out;
  }

  /** Count result -> adjustment moves (kept for simple callers). */
  function countMoves(place, counts, B, items, ts, kind) {
    return linesToMoves(place, countLines(place, counts, B, items), items, ts, kind);
  }

  /**
   * Rows pasted from Excel or a CSV: code, quantity, [landed cost], [name], [unit m/ea].
   * Tabs, commas or semicolons. A header row is skipped. Spaces and "R" in money are ignored.
   */
  function parseImport(text, items) {
    var rows = [], errors = [], seen = {};
    String(text || "").split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      var cells = line.split(line.indexOf("\t") >= 0 ? "\t" : /[;,](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(function (c) { return c.trim().replace(/^"|"$/g, "").trim(); });
      var sku = String(cells[0] || "").toUpperCase();
      var money = function (v) { return String(v || "").replace(/[R\s]/gi, "").replace(/,(\d{1,2})$/, ".$1").replace(/,/g, ""); };
      var qtyRaw = money(cells[1]);
      if (i === 0 && (isNaN(Number(qtyRaw)) || qtyRaw === "")) return; // header
      if (!sku) return;
      if (!/^[A-Z0-9][A-Z0-9_.\-]{0,40}$/.test(sku)) { errors.push("Line " + (i + 1) + ": item code '" + cells[0] + "' has spaces or odd characters."); return; }
      if (qtyRaw === "" || isNaN(Number(qtyRaw)) || Number(qtyRaw) < 0) { errors.push("Line " + (i + 1) + ": quantity for " + sku + " isn't a number."); return; }
      if (seen[sku]) { errors.push("Line " + (i + 1) + ": " + sku + " is listed twice."); return; }
      seen[sku] = 1;
      var costRaw = money(cells[2]);
      var row = { sku: sku, qty: round2(Number(qtyRaw)), cost: costRaw === "" || isNaN(Number(costRaw)) ? null : round2(Number(costRaw)),
        name: cells[3] || "", uom: /^m(etres?|eters?)?$/i.test(cells[4] || "") ? "m" : cells[4] ? "ea" : "", line: i + 1, isNew: !(items && items[sku]) };
      if (row.isNew && !row.name) { errors.push("Line " + (i + 1) + ": " + sku + " is a new item. Add its name in the 4th column."); return; }
      rows.push(row);
    });
    return { rows: rows, errors: errors };
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

  /** Real places hold physical stock and can't go below zero. */
  function isRealPlace(loc) { return loc === "WH" || /^VAN-/.test(loc || "") || /^JOB:/.test(loc || ""); }

  /**
   * Would these new movements push any real place below zero?
   * Returns null if fine, or a plain-English problem.
   */
  function checkBalances(existing, incoming, items) {
    var touched = {};
    (incoming || []).forEach(function (m) { if (isRealPlace(m.from)) touched[m.from + "\u0000" + m.sku] = [m.from, m.sku]; });
    var keys = Object.keys(touched);
    if (!keys.length) return null;
    var B = balances((existing || []).concat(incoming));
    for (var i = 0; i < keys.length; i++) {
      var loc = touched[keys[i]][0], sku = touched[keys[i]][1], b = bal(B, loc, sku);
      if (b < -0.005) {
        var name = (items && items[sku] && items[sku].name) || sku;
        var have = round2(b + (incoming || []).filter(function (m) { return m.from === loc && m.sku === sku; }).reduce(function (s, m) { return s + num(m.qty); }, 0)
          - (incoming || []).filter(function (m) { return m.to === loc && m.sku === sku; }).reduce(function (s, m) { return s + num(m.qty); }, 0));
        var where = loc === "WH" ? "the store" : loc.indexOf("JOB:") === 0 ? "job " + loc.slice(4) : loc;
        return "Not enough " + name + " in " + where + " (only " + have + "). Someone may have used it on another device. Refresh and check.";
      }
    }
    return null;
  }

  var Core = {
    balances: balances, bal: bal, kitDefault: kitDefault, jobSummary: jobSummary, closeJob: closeJob,
    newAverageCost: newAverageCost, onHand: onHand, losses: losses, overQuote: overQuote,
    countMoves: countMoves, countLines: countLines, linesToMoves: linesToMoves, parseImport: parseImport, parseScan: parseScan, nextNumber: nextNumber, round2: round2,
    isRealPlace: isRealPlace, checkBalances: checkBalances
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  else root.Core = Core;
})(this);
