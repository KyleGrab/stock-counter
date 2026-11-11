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
assert.strictEqual(C.kitDefault({ uom: "m", allowancePct: 10 }, 50), 55, "floating point: 50 m + 10% is 55, not 56");
assert.strictEqual(C.kitDefault({ uom: "m", allowancePct: 10 }, 51), 57, "56.1 rounds up to 57");

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

// --- v1.1 additions ---
// balance check: can't issue more than the store holds, LOSS/SUPPLIER can go negative
assert.strictEqual(C.checkBalances(moves, [{ sku: "PV6-RED", qty: 468, from: "WH", to: "JOB:J-2" }], items), null);
assert.ok(/Not enough PV cable|Not enough PV6-RED/.test(C.checkBalances(moves, [{ sku: "PV6-RED", qty: 469, from: "WH", to: "JOB:J-2" }], items)));
assert.strictEqual(C.checkBalances([], [{ sku: "X", qty: 5, from: "LOSS", to: "WH" }], {}), null);
assert.ok(C.checkBalances(moves, [{ sku: "PV6-RED", qty: 40, from: "JOB:J-1001", to: "WH" }], items), "can't return more than is out");

// reversals undo the right column
const rev = moves.concat([{ type: "reverse", reverses: "return", sku: "PV6-RED", qty: 3, from: "WH", to: "JOB:J-1001" },
                          { type: "reverse", reverses: "extra", sku: "PV6-RED", qty: 2, from: "JOB:J-1001", to: "WH" }]);
const rs = C.jobSummary("J-1001", lines, rev, items).find(r => r.sku === "PV6-RED");
assert.deepStrictEqual([rs.issued, rs.extra, rs.returned, rs.outstanding], [33, 0, 0, 32.5]);
assert.strictEqual(C.bal(C.balances(rev), "JOB:J-1001", "PV6-RED"), 32.5, "summary and ledger agree");
console.log("core v1.1: all tests passed");

// --- v1.3 inventory ---
const lines2 = C.countLines("WH", { "PV6-RED": 460, "PNL-550": "" }, B, items);
assert.deepStrictEqual(lines2, [{ sku: "PV6-RED", system: 468, counted: 460, diff: -8, value: -148 }]);
const lm = C.linesToMoves("WH", lines2, items, "t", "Shelf count", "CNT-1");
assert.strictEqual(lm[0].type, "countshort"); assert.strictEqual(lm[0].ref, "CNT-1"); assert.strictEqual(lm[0].qty, 8);
// import: Excel paste with header, tabs, rand amounts, new item
let im = C.parseImport("Code\tQty\tCost\tName\tUnit\npv6-red\t450\tR 18,90\nNEW-1\t12\t1 250.50\tBreaker 32A\tea\nCAB-10\t100\t\tCable 10mm\tmetres", items);
assert.deepStrictEqual(im.errors, []);
assert.deepStrictEqual(im.rows.map(r => [r.sku, r.qty, r.cost, r.isNew, r.uom]), [["PV6-RED", 450, 18.9, false, ""], ["NEW-1", 12, 1250.5, true, "ea"], ["CAB-10", 100, null, true, "m"]]);
im = C.parseImport("SKU,QTY\nPV6-RED,abc\nGHOST,5\nPV6-RED,1\nbad code,1", items);
assert.strictEqual(im.errors.length, 3);
assert.ok(/new item/.test(im.errors[0] + im.errors[1]));
console.log("core v1.3: all tests passed");

// --- v1.5 supplier invoices (made-up data) ---
{
  const inv = "Item Code\tDescription\tQuantity\tExcl VAT\tTotal Ex Vat\nABC BOX 4X4\tTest box\t3\t3.33\t10.00\nXY KW/H 1\tTest meter\t1\t500\t500.00\nWIRE 6 GRN\tTest wire\t100\t1.00\t100.00\tm\n\nSubtotal\t\t\t\t610.00\nVAT\t\t\t\t91.50";
  const r = C.parseImport(inv, {});
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.rows.map(x => x.sku), ["ABC-BOX-4X4", "XY-KW-H-1", "WIRE-6-GRN"], "spaces and slashes become dashes; footer lines skipped");
  assert.strictEqual(r.rows[0].cost, 3.3333, "cost from line total, 4 decimals, so the value matches the invoice");
  assert.strictEqual(r.rows[0].original, "ABC BOX 4X4");
  // semicolon CSV with comma decimals and R amounts
  const sc = C.parseImport("Item Code;Quantity;Description;Excl VAT\nABC BOX 4X4;48;Test box;R 1 017,86", {});
  assert.deepStrictEqual([sc.errors.length, sc.rows[0].qty, sc.rows[0].cost], [0, 48, 1017.86]);
  // columns found by name in any order
  const any = C.parseImport("Description,Unit,Qty,Code,Unit price\nTest wire,metres,50,W1,2.5", {});
  assert.deepStrictEqual([any.rows[0].sku, any.rows[0].qty, any.rows[0].cost, any.rows[0].uom, any.rows[0].name], ["W1", 50, 2.5, "m", "Test wire"]);
  // header doesn't match the rows -> clear error, nothing imported
  assert.strictEqual(C.parseImport("Quantity;Item Code\nABC;5", {}).rows.length, 0);
  assert.strictEqual(C.normCode("  xy 110 kw/h "), "XY-110-KW-H");
  assert.strictEqual(C.parseScan("abc box 4x4"), "ABC-BOX-4X4");
  console.log("core v1.5: all tests passed");
}
