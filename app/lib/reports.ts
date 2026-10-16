import { cents, type ReceiptWorkspace } from "./receipts.ts";

export type ReportShipment = { id: string; harvest_date: string; trader_id: string; variety_id: string; plot_id: string; containers: number; picking_cost: string | number | null };
export type ReportData = Omit<ReceiptWorkspace, "shipments"> & { shipments: ReportShipment[] };
export type ReportFilters = { from: string; to: string; trader: string; variety: string; plot: string };
export type ReportRow = { shipment: ReportShipment; paid: number; unpaid: number; kg: number; revenue: number; cost: number | null; age: number | null };

// Allocate every cent once, even when one receipt line spans several shipments.
export function splitCents(amount: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((weight) => amount * weight / sum);
  const parts = exact.map(Math.floor);
  let remainder = amount - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - parts[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) { if (remainder-- <= 0) break; parts[index]++; }
  return parts;
}

export function buildReport(data: ReportData, filters: ReportFilters, today: string): ReportRow[] {
  if (filters.from && filters.to && filters.from > filters.to) return [];
  const totals = new Map<string, { paid: number; kg: number; revenue: number }>();
  for (const receipt of data.receipts.filter((item) => item.status === "confirmed")) {
    for (const line of receipt.lines) {
      const amounts = splitCents(cents(line.amount), line.allocations.map((item) => Number(item.net_weight)));
      line.allocations.forEach((allocation, i) => {
        const current = totals.get(allocation.harvest_event_id) || { paid: 0, kg: 0, revenue: 0 };
        current.paid += Number(allocation.containers); current.kg += Number(allocation.net_weight); current.revenue += amounts[i];
        totals.set(allocation.harvest_event_id, current);
      });
    }
  }
  return data.shipments.filter((s) => (!filters.from || s.harvest_date >= filters.from) && (!filters.to || s.harvest_date <= filters.to)
    && (!filters.trader || s.trader_id === filters.trader) && (!filters.variety || s.variety_id === filters.variety) && (!filters.plot || s.plot_id === filters.plot))
    .map((shipment) => {
      const total = totals.get(shipment.id) || { paid: 0, kg: 0, revenue: 0 };
      return { shipment, ...total, unpaid: Math.max(0, Math.round((Number(shipment.containers) - total.paid) * 1000) / 1000),
        cost: shipment.picking_cost == null ? null : cents(String(shipment.picking_cost)),
        age: shipment.harvest_date ? Math.max(0, Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(shipment.harvest_date + "T00:00:00Z")) / 86400000)) : null };
    });
}

export type GroupRow = { key: string; containers: number; unpaid: number; kg: number; revenue: number; cost: number; missingCost: number };
export function groupReport(rows: ReportRow[], keyFor: (row: ReportRow) => string): GroupRow[] {
  const groups = new Map<string, GroupRow>();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) || { key, containers: 0, unpaid: 0, kg: 0, revenue: 0, cost: 0, missingCost: 0 };
    group.containers += Number(row.shipment.containers); group.unpaid += row.unpaid; group.kg += row.kg;
    group.revenue += row.revenue; group.cost += row.cost || 0; group.missingCost += row.cost === null ? 1 : 0;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, "he"));
}

// Missing months remain explicit gaps; prices are weighted by allocated net kg.
export function monthlyVarietyPrices(rows: ReportRow[]) {
  const groups = groupReport(rows.filter(r => /^\d{4}-\d{2}/.test(r.shipment.harvest_date)), r => JSON.stringify([r.shipment.variety_id, r.shipment.harvest_date.slice(0,7)])).filter(g => g.kg > 0);
  const dates = groups.map(g => JSON.parse(g.key)[1] as string).sort();
  const months: string[] = [];
  if (dates.length) {
    const [year, month] = dates[0].split('-').map(Number);
    for (let d = new Date(Date.UTC(year,month-1,1)); d.toISOString().slice(0,7) <= dates[dates.length-1]; d.setUTCMonth(d.getUTCMonth()+1)) months.push(d.toISOString().slice(0,7));
  }
  const ids = [...new Set(groups.map(g => JSON.parse(g.key)[0] as string))].sort();
  const byKey = new Map(groups.map(g => [g.key,g]));
  return { months, series: ids.map(id => ({ id, points: months.map(month => {
    const g = byKey.get(JSON.stringify([id,month]));
    return g ? { month, kg:g.kg, revenue:g.revenue, price:g.revenue/100/g.kg } : null;
  }) })) };
}
