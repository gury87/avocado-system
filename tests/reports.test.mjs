import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, groupReport, splitCents, monthlyVarietyPrices } from "../app/lib/reports.ts";
import { workbook } from "../app/lib/excel.ts";
const shipments = [
  { id: "1", harvest_date: "2026-09-01", trader_id: "1", variety_id: "1", plot_id: "1", containers: 4, picking_cost: "520" },
  { id: "2", harvest_date: "2026-09-02", trader_id: "1", variety_id: "1", plot_id: "2", containers: 3, picking_cost: null },
  { id: "3", harvest_date: "2026-10-01", trader_id: "2", variety_id: "2", plot_id: "1", containers: 1, picking_cost: 130 },
];
const line = (amount, allocations) => ({ amount, allocations: allocations.map(([id, containers, kg]) => ({ harvest_event_id: id, containers: String(containers), net_weight: String(kg) })) });
const data = { shipments, traders: [], receipts: [
  { status: "confirmed", lines: [line("100.01", [["1", 1, 10], ["2", 2, 20]]), line("300", [["3", 1, 100]])] },
  { status: "draft", lines: [line("500", [["1", 3, 300]])] },
  { status: "cancelled", lines: [line("200", [["2", 1, 100]])] },
] };
const filters = { from: "", to: "", trader: "", variety: "", plot: "" };
test("Reports preserve cents across split shipments, ignore drafts/cancellations and show partial balances", () => {
  assert.deepEqual(splitCents(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(splitCents(0, [1, 2]), [0, 0]);
  const rows = buildReport(data, filters, "2026-10-15");
  assert.deepEqual(rows.map((r) => r.unpaid), [3, 1, 0]);
  assert.deepEqual(rows.map((r) => r.revenue), [3334, 6667, 30000]);
  assert.equal(rows[0].age, 44);
  const [total] = groupReport(rows, () => "all");
  assert.equal(total.revenue, 40001); assert.equal(total.kg, 130);
  assert.equal(total.unpaid, 4); assert.equal(total.cost, 65000); assert.equal(total.missingCost, 1);
  const byTrader = groupReport(rows, (r) => r.shipment.trader_id);
  assert.equal(byTrader[0].unpaid, 4);
  assert.notEqual(total.revenue / total.kg, (3334 / 10 + 6667 / 20 + 30000 / 100) / 3, "Prices must be weighted by kg");
});
test("Reports use shipment dates and independently apply trader, variety and plot filters", () => {
  const report = buildReport(data, { ...filters, from: "2026-09-01", to: "2026-09-02", trader: "1", plot: "2", variety: "1" }, "2026-10-15");
  assert.equal(report.length, 1); assert.equal(report[0].shipment.id, "2");
  assert.equal(report[0].revenue, 6667, "A filtered allocation keeps its original share, never the entire line amount");
  assert.equal(report[0].cost, null);
  assert.deepEqual(buildReport(data, { ...filters, from: "2027-01-01", to: "2026-01-01" }, "2026-10-15"), []);
  assert.equal(buildReport(data, { ...filters, trader: "missing" }, "2026-10-15").length, 0);
});
test("Excel export writes an XLSX package with RTL sheets, numeric cells and safe literal text", () => {
  const result = workbook([{ name: "דוח", rows: [["זן", "מחיר"], ["=HYPERLINK(\"bad\")<&", 12.34], ["חלקה", null]] }]);
  assert.equal(new DataView(result.buffer).getUint32(0, true), 0x04034b50);
  const text = new TextDecoder().decode(result);
  assert.ok(text.includes('rightToLeft="1"'));
  assert.ok(text.includes("<v>12.34</v>"));
  assert.ok(text.includes('t="inlineStr"')); assert.ok(text.includes("&lt;&amp;"));
  assert.ok(!text.includes("<f>"));
  assert.ok(text.includes("xl/workbook.xml"));
});

test("Monthly prices weight kg, split varieties and retain missing-month gaps", () => {
  const rows=buildReport(data,filters,"2026-10-15");
  rows.push({...rows[0],shipment:{...rows[0].shipment,harvest_date:"2026-12-01"},kg:90,revenue:90000});
  const chart=monthlyVarietyPrices(rows);
  assert.deepEqual(chart.months,["2026-09","2026-10","2026-11","2026-12"]);
  assert.equal(chart.series[0].points[0].price,100.01/30);
  assert.equal(chart.series[0].points[1],null);
  assert.equal(chart.series[0].points[2],null);
  assert.equal(chart.series[0].points[3].price,10);
  assert.equal(chart.series[1].points[1].price,3);
  assert.deepEqual(monthlyVarietyPrices([]),{months:[],series:[]});
});
