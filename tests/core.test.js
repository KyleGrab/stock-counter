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

// --- v1.6 units and VAT ---
{
  assert.deepStrictEqual(["m", "Metres", "mtr", "in", "inches", '"', "ea", "each", ""].map(C.unitOf), ["m", "m", "m", "in", "in", "in", "ea", "ea", ""]);
  assert.strictEqual(C.kitDefault({ uom: "in", allowancePct: 10 }, 20), 22, "inches get the length allowance too");
  // price column labelled incl VAT -> 15% taken off; excl column preferred when both exist
  let r = C.parseImport("Item code,Qty,Price incl VAT\nA1,2,115", {"A1": {}});
  assert.deepStrictEqual([r.rows[0].cost, r.rows[0].vatRemoved], [100, true]);
  r = C.parseImport("Item code,Qty,Total Incl VAT,Total Excl VAT\nA1,4,460,400", {"A1": {}});
  assert.deepStrictEqual([r.rows[0].cost, r.rows[0].vatRemoved], [100, false]);
  r = C.parseImport("Item code,Qty,Total Ex Vat,Unit\nA1,4,400,inch", {"A1": {}});
  assert.deepStrictEqual([r.rows[0].cost, r.rows[0].uom, r.rows[0].vatRemoved], [100, "in", false]);
  console.log("core v1.6: all tests passed");
}

// --- v1.12 stock out ---
{
  const items2 = { "X-1": { name: "Test item", cost: 10 } };
  const base = [{ type: "receive", sku: "X-1", qty: 10, from: "SUPPLIER", to: "WH" }];
  const o = { type: "out", sku: "X-1", qty: 4, from: "WH", to: "OUT" };
  assert.strictEqual(C.isRealPlace("OUT"), false, "OUT is not a real place");
  assert.strictEqual(C.checkBalances(base, [o], items2), null, "stock out within store stock is fine");
  assert.ok(C.checkBalances(base, [{ ...o, qty: 11 }], items2), "can't take out more than the store has");
  const B2 = C.balances(base.concat([o]));
  assert.strictEqual(C.bal(B2, "WH", "X-1"), 6);
  assert.strictEqual(C.onHand(B2, "X-1"), 6, "stock sent out is no longer on hand");
  // reversing a stock out to a job takes it off the job's issued column again
  const jm = base.concat([{ type: "out", sku: "X-1", qty: 4, from: "WH", to: "JOB:J-9", job: "J-9" },
                          { type: "reverse", reverses: "out", sku: "X-1", qty: 4, from: "JOB:J-9", to: "WH", job: "J-9" }]);
  const js = C.jobSummary("J-9", [], jm, items2).find(r => r.sku === "X-1");
  assert.deepStrictEqual([js.issued, js.outstanding], [0, 0]);
  console.log("core v1.12: all tests passed");
}

// v1.13 daily log helpers
{
  assert.strictEqual(C.saDay("2026-11-12T23:30:00Z"), "2026-11-13", "23:30 UTC on the 12th is the 13th in South Africa");
  assert.strictEqual(C.saDay("2026-11-12T21:59:59.999Z"), "2026-11-12", "just before midnight SA time");
  assert.strictEqual(C.saDay("2026-11-12T22:00:00Z"), "2026-11-13", "22:00 UTC is midnight SA time");
  assert.strictEqual(C.saDay("2026-12-31T22:30:00Z"), "2027-01-01", "year rolls over");
  assert.strictEqual(C.saDay("2026-07-01T10:00:00Z"), "2026-07-01", "no daylight saving in winter");
  assert.strictEqual(C.saDay("garbage"), "");
  assert.strictEqual(C.saTime("2026-11-12T23:30:00Z"), "01:30");
  assert.strictEqual(C.addDays("2026-11-30", 1), "2026-12-01");
  assert.strictEqual(C.addDays("2026-03-01", -1), "2026-02-28");
  assert.strictEqual(C.addDays("nope", 1), "");
  assert.ok(C.isDay("2026-02-28") && !C.isDay("2026-02-30") && !C.isDay("2026-2-3") && !C.isDay(""));
  const g = C.groupMoves([{ ts: "t1", by: "a", id: 1 }, { ts: "t1", by: "b", id: 2 }, { ts: "t1", by: "a", id: 3 }, { ts: "t2", by: "a", id: 4 }]);
  assert.deepStrictEqual(g.map(x => x.moves.map(m => m.id)), [[1, 3], [2], [4]]);
  assert.strictEqual(C.taskLabel(["return", "scrap", "used", "missing"]), "Job closed");
  assert.strictEqual(C.taskLabel(["out"]), "Stock out");
  assert.strictEqual(C.taskLabel(["reverse"]), "Correction");
  assert.strictEqual(C.taskLabel(["countshort", "countover", "kituse"]), "Count adjustment");
  assert.strictEqual(C.taskLabel(["kit"]), "Kitted to job");
  assert.strictEqual(C.taskKind(["receive"]), "in");
  assert.strictEqual(C.taskKind(["reverse"]), "fixes");
  // CSV
  assert.strictEqual(C.csvCell("plain"), "plain");
  assert.strictEqual(C.csvCell("a,b"), '"a,b"');
  assert.strictEqual(C.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(C.csvCell("line1\nline2"), '"line1\nline2"');
  assert.strictEqual(C.csvCell("=1+1"), "'=1+1");
  assert.strictEqual(C.csvCell("+27 82"), "'+27 82");
  assert.strictEqual(C.csvCell("-5 m"), "'-5 m");
  assert.strictEqual(C.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.strictEqual(C.csvCell('=HYPERLINK("x","y")'), "\"'=HYPERLINK(\"\"x\"\",\"\"y\"\")\"");
  assert.strictEqual(C.csvCell(-5), "-5", "real numbers are not mangled");
  assert.strictEqual(C.csvCell(null), "");
  assert.strictEqual(C.csv([["a", 1], ["b,c", 2.5]]), 'a,1\r\n"b,c",2.5');
  console.log("core v1.13: daily log helpers passed");
}
