"use client";

import { useState } from "react";
import {
  calculatedAmount, cents, dateLabel, matchCandidates, money,
  type Receipt, type ReceiptLine, type ReceiptWorkspace,
} from "../lib/receipts";
import { useCatalog } from "./FarmCatalog";
import { catalogOptions } from "../lib/catalog";
import WeightBreakdown from "./WeightBreakdown";

const inputClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base font-normal";

export default function ReceiptLineEditor({ receipt, line, position, workspace, original, onChange, onRemove }: {
  receipt: Receipt; line: ReceiptLine; position: number; workspace: ReceiptWorkspace;
  original?: Receipt; onChange: (line: ReceiptLine) => void; onRemove: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const {catalog,plots,varieties}=useCatalog();
  const candidates = matchCandidates(workspace.shipments, receipt, line, original);
  const shown = showAll ? candidates : candidates.slice(0, 3);
  const assignedContainers = line.allocations.reduce((sum, allocation) => sum + Number(allocation.containers || 0), 0);
  const assignedWeight = line.allocations.reduce((sum, allocation) => sum + Number(allocation.net_weight || 0), 0);
  const complete = line.allocations.length > 0 && Math.abs(assignedContainers - Number(line.containers)) < 0.0005 && Math.abs(assignedWeight - Number(line.net_weight)) < 0.0005;
  const update = (key: keyof ReceiptLine, value: string) => {
    if (key === "variety_id" && line.allocations.length && !window.confirm("שינוי הזן ינקה את השיוכים בשורה זו. להמשיך?")) return;
    const next = { ...line, [key]: value };
    if (key === "variety_id") next.allocations = [];
    if ((key === "net_weight" || key === "price_per_kg") &&
      (!line.amount || cents(line.amount) === cents(calculatedAmount(line.net_weight, line.price_per_kg)))) {
      next.amount = calculatedAmount(next.net_weight, next.price_per_kg);
    }
    onChange(next);
  };
  const addAllocation = (id: string) => {
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate) return;
    const count = Math.max(0, Math.min(candidate.available, Number(line.containers) - assignedContainers));
    if (count <= 0) { window.alert("יש להזין מספר מיכלים ולוודא שנותרו מיכלים לשיוך בשורה."); return; }
    const remainingWeight = Math.max(0, Number(line.net_weight) - assignedWeight);
    const weight = Math.round(Math.min(remainingWeight, Number(line.net_weight) * count / Number(line.containers)) * 1000) / 1000;
    onChange({ ...line, allocations: [...line.allocations, { harvest_event_id: id, containers: String(count), net_weight: String(weight) }] });
  };
  const expected = calculatedAmount(line.net_weight, line.price_per_kg);
  return <details open className="rounded-2xl border border-zinc-200 bg-white">
    <summary className="min-h-11 cursor-pointer p-4 font-semibold">
      שורה {position} · {varieties[line.variety_id]} · {line.containers || "0"} מיכלים · {money(cents(line.amount))}
    </summary>
    <div className="space-y-4 px-4 pb-4">
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
        <label className="min-w-0 text-sm">תאריך אצל הסוחר<input type="date" value={line.trader_date} onChange={(e) => update("trader_date", e.target.value)} className={inputClass} /></label>
        <label className="min-w-0 text-sm">זן<select value={line.variety_id} onChange={(e) => update("variety_id", e.target.value)} className={inputClass}>{catalogOptions(catalog.varieties,original?.lines.find((l)=>l.id===line.id)?.variety_id).map((e) => <option key={e.id} value={e.id}>{e.name}{e.active?"":" (לא פעיל)"}</option>)}</select></label>
        {([
          ["gross_weight", "משקל ברוטו (ק״ג)", "0.001"], ["containers", "מספר מיכלים", "0.001"],
          ["tare_weight", "משקל מיכל בודד (ק״ג)", "0.001"], ["net_weight", "משקל נטו (ק״ג)", "0.001"],
          ["price_per_kg", "מחיר לק״ג (₪)", "0.0001"], ["amount", "סכום לפי מסמך הסוחר (₪)", "0.01"],
        ] as const).map(([key, label, step]) => <label key={key} className="min-w-0 text-sm">{label}<input type="number" inputMode="decimal" min="0" step={step} value={line[key]} onChange={(e) => update(key, e.target.value)} className={inputClass} /></label>)}
      </div>
      <p className="text-xs text-zinc-500">הברוטו והנטו נרשמים כפי שמופיעים במסמך הסוחר. תאריך הסוחר אינו משנה את תאריך השיווק.</p>
      <WeightBreakdown line={line} />
      {expected && <div className="text-sm"><p>נטו × מחיר: {money(cents(expected))}</p>{line.amount && cents(line.amount) !== cents(expected) && <p className="text-amber-800">הפרש מהסכום במסמך: {money(cents(line.amount) - cents(expected))}</p>}<button type="button" onClick={() => onChange({ ...line, amount: expected })} className="min-h-11 underline">השתמש בסכום המחושב</button></div>}

      <div className="space-y-3 border-t border-zinc-200 pt-3">
        <h3 className="font-semibold">שיוך לשיווקים</h3>
        <p className="text-xs text-zinc-500">הצעות בלבד — השיוך מתבצע בלחיצה שלך. בפיצול בין שיווקים יש לאשר את חלוקת המיכלים והנטו.</p>
        {line.allocations.map((allocation, index) => {
          const shipment = workspace.shipments.find((item) => item.id === allocation.harvest_event_id);
          const candidate = candidates.find((item) => item.id === allocation.harvest_event_id);
          return <div key={allocation.harvest_event_id} className="space-y-2 rounded-xl border border-green-200 bg-green-50 p-3">
            <p className="text-sm">{shipment ? `${dateLabel(shipment.harvest_date)} · ${varieties[shipment.variety_id]} · ${plots[shipment.plot_id] || "חלקה לא ידועה"}` : "שיווק לא זמין"}</p>
            {candidate && <p className="text-xs text-zinc-600">ניתן לשייך לשורה זו עד {candidate.available} מיכלים</p>}
            <div className="grid grid-cols-2 gap-2">
              {([ ["containers", "מיכלים בשיוך"], ["net_weight", "נטו בשיוך (ק״ג)"] ] as const).map(([key, label]) => <label key={key} className="min-w-0 text-xs">{label}<input type="number" inputMode="decimal" min={key === "containers" ? "0.001" : "0"} step="0.001" value={allocation[key]} className={inputClass} onChange={(e) => onChange({ ...line, allocations: line.allocations.map((item, i) => i === index ? { ...item, [key]: e.target.value } : item) })} /></label>)}
            </div>
            <button type="button" className="min-h-11 text-sm text-red-700" onClick={() => onChange({ ...line, allocations: line.allocations.filter((_, i) => i !== index) })}>הסר שיוך</button>
          </div>;
        })}
        <p className={`text-sm ${complete ? "text-green-800" : "text-amber-800"}`}>
          שויכו {assignedContainers.toLocaleString("he-IL", { maximumFractionDigits: 3 })} מתוך {line.containers || 0} מיכלים · {assignedWeight.toLocaleString("he-IL", { maximumFractionDigits: 3 })} מתוך {line.net_weight || 0} ק״ג נטו
        </p>
        {shown.filter((candidate) => !line.allocations.some((allocation) => allocation.harvest_event_id === candidate.id)).map((candidate) => <div key={candidate.id} className="rounded-lg border border-zinc-200 p-3 text-sm">
          <p className="font-medium">{dateLabel(candidate.harvest_date)} · {plots[candidate.plot_id] || "חלקה לא ידועה"}</p>
          <p>{candidate.available} מיכלים זמינים לשורה</p>
          <p className="text-xs text-zinc-500">זן וסוחר תואמים{candidate.exact ? " · כמות מיכלים תואמת" : ""}{candidate.days !== null ? ` · הפרש ${Math.abs(candidate.days)} ימים${candidate.days < 0 ? " (השיווק מאוחר מתאריך הסוחר)" : ""}` : ""}</p>
          <button type="button" onClick={() => addAllocation(candidate.id)} className="mt-2 min-h-11 w-full rounded-lg bg-zinc-900 px-3 text-white">שייך לשורה</button>
        </div>)}
        {candidates.length === 0 && <p className="text-sm text-zinc-500">אין שיווקים זמינים התואמים לסוחר ולזן. אפשר לשמור טיוטה ולהשלים את השיוך בהמשך.</p>}
        <button type="button" onClick={() => setShowAll(!showAll)} className="min-h-11 text-sm underline">{showAll ? "הצג הצעות מובילות" : "בחירה ידנית — כל השיווקים המתאימים"}</button>
      </div>
      <button type="button" className="min-h-11 text-sm text-red-700" onClick={() => { if (window.confirm("להסיר את שורת הפירוט והשיוכים שלה?")) onRemove(); }}>הסר שורת פירוט</button>
    </div>
  </details>;
}
