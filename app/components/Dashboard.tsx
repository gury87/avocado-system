"use client";

import { useState } from "react";
import type { PaidWeight } from "../lib/receipts";

type Shipment = {
  id: string;
  date: string;
  plot: string;
  variety: string;
  containers: number;
};

export default function Dashboard({ shipments, paidWeights, weightsError }: { shipments: Shipment[]; paidWeights: PaidWeight[] | null; weightsError: boolean }) {
  const [filters, setFilters] = useState({ from: "", to: "", plot: "", variety: "" });
  const [groupBy, setGroupBy] = useState<"plot" | "variety" | "both">("plot");
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);
  const filtered = shipments.filter((shipment) =>
    !invalidRange &&
    (!filters.from || shipment.date >= filters.from) &&
    (!filters.to || shipment.date <= filters.to) &&
    (!filters.plot || shipment.plot === filters.plot) &&
    (!filters.variety || shipment.variety === filters.variety)
  );
  const total = filtered.reduce((sum, shipment) => sum + shipment.containers, 0);
  const weightById = new Map(paidWeights?.map((item) => [item.harvest_event_id, item]) || []);
  const paidKg = filtered.reduce((sum, shipment) => sum + (weightById.get(shipment.id)?.net_weight || 0), 0);
  const paidContainers = filtered.reduce((sum, shipment) => sum + (weightById.get(shipment.id)?.containers || 0), 0);
  const weightAvailable = paidWeights !== null && !weightsError;
  const unpaidByVariety = new Map<string, number>();
  for (const shipment of filtered) {
    const remaining = Math.max(0, shipment.containers - (weightById.get(shipment.id)?.containers || 0));
    unpaidByVariety.set(shipment.variety, (unpaidByVariety.get(shipment.variety) || 0) + remaining);
  }
  const unpaidTotal = [...unpaidByVariety.values()].reduce((sum, count) => sum + count, 0);
  const partialWeight = paidContainers + 0.0005 < total;
  const kgLabel = (value: number) => value.toLocaleString("he-IL", { maximumFractionDigits: 3 });
  const groups = new Map<string, { plot: string; variety: string; containers: number; kg: number; paidContainers: number }>();
  for (const shipment of filtered) {
    const plot = groupBy === "variety" ? "" : shipment.plot;
    const variety = groupBy === "plot" ? "" : shipment.variety;
    const key = JSON.stringify([plot, variety]);
    const existing = groups.get(key);
    const paid = weightById.get(shipment.id);
    if (existing) {
      existing.containers += shipment.containers;
      existing.kg += paid?.net_weight || 0;
      existing.paidContainers += paid?.containers || 0;
    } else groups.set(key, { plot, variety, containers: shipment.containers, kg: paid?.net_weight || 0, paidContainers: paid?.containers || 0 });
  }
  const rows = [...groups.entries()].sort(([, a], [, b]) =>
    a.plot.localeCompare(b.plot, "he") || a.variety.localeCompare(b.variety, "he")
  );
  const controlClass = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base text-zinc-900";

  return (
    <section className="space-y-4 text-zinc-900" aria-label="דשבורד שיווקים">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">סינון נתונים</h2>
        <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
          <label className="min-w-0 text-sm">
            <span className="mb-1 block">מתאריך שיווק</span>
            <input type="date" value={filters.from} max={filters.to || undefined}
              aria-invalid={invalidRange}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })} className={controlClass} />
          </label>
          <label className="min-w-0 text-sm">
            <span className="mb-1 block">עד תאריך שיווק</span>
            <input type="date" value={filters.to} min={filters.from || undefined}
              aria-invalid={invalidRange}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })} className={controlClass} />
          </label>
          {([{ key: "plot", label: "חלקה", all: "כל החלקות" }, { key: "variety", label: "זן", all: "כל הזנים" }] as const).map(({ key, label, all }) => (
            <label key={key} className="min-w-0 text-sm">
              <span className="mb-1 block">{label}</span>
              <select value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })} className={controlClass}>
                <option value="">{all}</option>
                {[...new Set(shipments.map((shipment) => shipment[key]))].filter(Boolean)
                  .sort((a, b) => a.localeCompare(b, "he"))
                  .map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          ))}
        </div>
        {invalidRange && <p role="alert" className="mt-3 text-sm text-red-600">תאריך הסיום חייב להיות בתאריך ההתחלה או אחריו.</p>}
        <button type="button" onClick={() => setFilters({ from: "", to: "", plot: "", variety: "" })}
          className="mt-3 min-h-11 rounded-lg border border-zinc-300 px-3 text-sm">נקה סינון</button>
      </div>

      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-3" aria-live="polite">
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm text-zinc-500">סה״כ מיכלים</h2>
          <p className="mt-2 break-words text-3xl font-bold">{invalidRange ? "—" : total.toLocaleString("he-IL")}</p>
          <p className="mt-1 text-xs text-zinc-500">{filtered.length} שיווקים בסינון הנוכחי</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm text-zinc-500">משקל נטו ששולם (ק״ג)</h2>
          {weightAvailable && paidContainers > 0 && !invalidRange
            ? <><p className="mt-2 break-words text-3xl font-bold">{kgLabel(paidKg)}</p><p className="mt-1 text-xs text-zinc-500">{partialWeight ? "נתון חלקי · " : ""}{kgLabel(paidContainers)} מתוך {kgLabel(total)} מיכלים שולמו</p></>
            : <p className="mt-2 text-sm text-zinc-600">{weightsError ? "לא ניתן לטעון את נתוני המשקל" : invalidRange ? "יש לתקן את טווח התאריכים" : !weightAvailable ? "טוען נתוני משקל…" : "נתוני משקל טרם זמינים"}</p>}
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm text-amber-900">מיכלים שטרם שולמו</h2>
          <p data-unpaid-total className="mt-2 break-words text-3xl font-bold">{weightAvailable && !invalidRange ? kgLabel(unpaidTotal) : "—"}</p>
          <p className="mt-1 text-xs text-zinc-600">{weightsError ? "לא ניתן לטעון נתוני תשלום" : !weightAvailable ? "טוען נתוני תשלום…" : invalidRange ? "יש לתקן את טווח התאריכים" : "לפי הסינון הנוכחי · לאחר הפחתת שיוכים מאושרים"}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <h2 className="p-4 text-lg font-semibold">מיכלים שטרם שולמו לפי זן</h2>
        {weightAvailable && !invalidRange ? <table data-unpaid-varieties className="w-full table-fixed text-right text-sm">
          <thead className="bg-zinc-50"><tr><th scope="col" className="px-4 py-3">זן</th><th scope="col" className="px-4 py-3">מיכלים שטרם שולמו</th></tr></thead>
          <tbody className="divide-y divide-zinc-100">
            {[...unpaidByVariety].sort(([a], [b]) => a.localeCompare(b, "he")).map(([variety, count]) => <tr key={variety}><td className="px-4 py-3">{variety || "לא ידוע"}</td><td className="px-4 py-3">{kgLabel(count)}</td></tr>)}
            {!unpaidByVariety.size && <tr><td colSpan={2} className="p-4 text-zinc-500">אין שיווקים התואמים לסינון</td></tr>}
          </tbody>
          <tfoot className="border-t border-zinc-200 font-semibold"><tr><th scope="row" className="px-4 py-3">סה״כ</th><td className="px-4 py-3">{kgLabel(unpaidTotal)}</td></tr></tfoot>
        </table> : <p className="px-4 pb-4 text-sm text-zinc-600">{weightsError ? "לא ניתן לטעון נתוני תשלום" : invalidRange ? "יש לתקן את טווח התאריכים" : "טוען נתוני תשלום…"}</p>}
      </div>

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <h2 className="p-4 text-lg font-semibold">פירוט שיווקים</h2>
        <div className="flex gap-2 px-4 pb-4" aria-label="קיבוץ נתונים">
          {([{ value: "plot", label: "לפי חלקה" }, { value: "variety", label: "לפי זן" }, { value: "both", label: "חלקה וזן" }] as const).map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={groupBy === value} onClick={() => setGroupBy(value)}
              className={`min-h-11 min-w-0 flex-1 rounded-lg px-2 py-2 text-sm ${groupBy === value ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <caption className="sr-only">מיכלים לפי {groupBy === "plot" ? "חלקה" : groupBy === "variety" ? "זן" : "חלקה וזן"}</caption>
            <thead className="bg-zinc-50">
              <tr>
                {groupBy !== "variety" && <th scope="col" className="px-3 py-3">חלקה</th>}
                {groupBy !== "plot" && <th scope="col" className="px-3 py-3">זן</th>}
                <th scope="col" className="px-3 py-3">מיכלים</th>
                <th scope="col" className="px-3 py-3">נטו ששולם (ק״ג)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map(([key, row]) => (
                <tr key={key}>
                  {groupBy !== "variety" && <td className="px-3 py-3">{row.plot || "לא ידוע"}</td>}
                  {groupBy !== "plot" && <td className="px-3 py-3">{row.variety || "לא ידוע"}</td>}
                  <td className="px-3 py-3">{row.containers.toLocaleString("he-IL")}</td>
                  <td className="px-3 py-3">
                    {weightAvailable && row.paidContainers > 0 ? <>{kgLabel(row.kg)}{row.paidContainers + 0.0005 < row.containers && <span className="block text-xs text-amber-800">חלקי</span>}</> : <span aria-label="נתוני משקל אינם זמינים">—</span>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={groupBy === "both" ? 4 : 3} className="p-4 text-center text-zinc-500">{invalidRange ? "יש לתקן את טווח התאריכים" : "אין שיווקים התואמים לסינון"}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="border-t border-zinc-200 p-3 text-xs text-zinc-500">הנטו מבוסס על שיוכים בתקבולים מאושרים בלבד, לפי תאריך השיווק המקורי. כל עוד לא שולמו כל המיכלים, נתוני המשקל חלקיים. טיוטות ותקבולים מבוטלים אינם נכללים.</p>
      </div>
    </section>
  );
}
