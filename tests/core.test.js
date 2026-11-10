const assert = require("assert");
const C = require("../core.js");

const items = {
  "PV6-RED": { sku: "PV6-RED", uom: "m", cost: 18.5, allowancePct: 10 },
  "PNL-550": { sku: "PNL-550", uom: "ea", cost: 1850 }
};
const job = { no: "J-1001", van: "VAN-1", installer: "Sipho" };
const lines = [{ job: "J-1001", sku: "PV6-RED", quoted: 30 }, { job: "J-1001", sku: "PNL-550", quoted: 12 }];
const moves = [
  { type: "receive", sku: "PV6-RED", qty: 500, from: "SUPPLIER", to: "WH" },
  { type: "receive", sku: "PNL-550", qty: 20, from: "SUPPLIER", to: "WH" },
  { type: "kit", sku: "PV6-RED", qty: 33, from: "WH", to: "JOB:J-1001", job: "J-1001" },
  { type: "kit", sku: "PNL-550", qty: 12, from: "WH", to: "JOB:J-1001", job: "J-1001" },
  { type: "extra", sku: "PV6-RED", qty: 2, from: "WH", to: "JOB:J-1001", job: "J-1001" },
  { type: "return", sku: "PV6-RED", qty: 3, from: "JOB:J-1001", to: "WH", job: "J-1001" },
  { type: "scrap", sku: "PV6-RED", qty: 0.5, from: "JOB:J-1001", to: "SCRAP", job: "J-1001" }
];

// kit allowance: 30 m + 10% = 33 m; units unchanged
assert.strictEqual(C.kitDefault(items["PV6-RED"], 30), 33);
assert.strictEqual(C.kitDefault(items["PNL-550"], 12), 12);
assert.strictEqual(C.kitDefault({ uom: "m" }, 10), 11, "default allowance 10%");

// balances
const B = C.balances(moves);
assert.strictEqual(C.bal(B, "WH", "PV6-RED"), 468);
assert.strictEqual(C.bal(B, "JOB:J-1001", "PV6-RED"), 31.5);
assert.strictEqual(C.onHand(B, "PV6-RED"), 499.5);

// job summary
const S = C.jobSummary("J-1001", lines, moves, items);
const red = S.find(r => r.sku === "PV6-RED");
assert.deepStrictEqual([red.quoted, red.issued, red.extra, red.returned, red.scrap, red.outstanding], [30, 35, 2, 3, 0.5, 31.5]);

// close: installer used 29.5 m, 12 panels -> 2 m missing
const res = C.closeJob(job, S, { "PV6-RED": 29.5, "PNL-550": 12 }, "2026-11-10T10:00:00Z");
assert.deepStrictEqual(res.problems, []);
assert.strictEqual(res.missingValue, 37);
const after = C.jobSummary("J-1001", lines, moves.concat(res.moves), items);
after.forEach(r => assert.strictEqual(r.outstanding, 0, "job fully accounted"));
assert.strictEqual(after.find(r => r.sku === "PV6-RED").missing, 2);

// close blocked when a line has no 'used' figure
assert.deepStrictEqual(C.closeJob(job, S, { "PV6-RED": 30 }, "x").problems, ["PNL-550"]);
// used can't exceed what's out
const capped = C.closeJob(job, S, { "PV6-RED": 99, "PNL-550": 12 }, "x");
assert.strictEqual(capped.missingValue, 0);

// over-quote: consumed 31.5 vs quoted 30 = 5% -> not flagged at 10%, flagged at 2%
assert.strictEqual(C.overQuote(after, 10).length, 0);
assert.strictEqual(C.overQuote(after, 2)[0].sku, "PV6-RED");

// losses
const L = C.losses(moves.concat(res.moves).map(m => ({ ts: "2026-11-10T10:00:00Z", ...m })), 30, Date.parse("2026-11-11"));
assert.strictEqual(L.total, 37);
assert.strictEqual(L.byInstaller["Sipho"], 37);
assert.strictEqual(L.byVan["VAN-1"], 37);

// counts: warehouse short 8 m -> loss; van short -> kit use; over -> gain
const wc = C.countMoves("WH", { "PV6-RED": 460 }, B, items, "t", "weekly");
assert.strictEqual(wc[0].type, "countshort"); assert.strictEqual(wc[0].qty, 8); assert.strictEqual(wc[0].value, 148);
const vB = C.balances([{ sku: "PV6-RED", qty: 10, from: "WH", to: "VAN-1" }]);
assert.strictEqual(C.countMoves("VAN-1", { "PV6-RED": 7 }, vB, items, "t")[0].type, "kituse");
assert.strictEqual(C.countMoves("WH", { "PV6-RED": 470 }, B, items, "t")[0].type, "countover");
assert.strictEqual(C.countMoves("WH", { "PV6-RED": "" }, B, items, "t").length, 0, "blank = not counted");

// average cost
assert.strictEqual(C.newAverageCost(100, 18, 100, 20), 19);
assert.strictEqual(C.newAverageCost(0, 0, 50, 21.5), 21.5);

// scan parsing
assert.strictEqual(C.parseScan("gs-0001"), "GS-0001");
assert.strictEqual(C.parseScan("https://x.github.io/stock/?c=GS-0007"), "GS-0007");
assert.strictEqual(C.parseScan("https://x.github.io/stock/#c=J-1003"), "J-1003");

// numbering
assert.strictEqual(C.nextNumber(["J-1001", "J-1009", "X-5"], "J-", 4), "J-1010");
assert.strictEqual(C.nextNumber([], "GS-", 4), "GS-0001");

console.log("core: all tests passed");
