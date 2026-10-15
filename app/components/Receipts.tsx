"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthGate";
import ReceiptLineEditor from "./ReceiptLineEditor";
import Documents from "./Documents";
import {
  cents, dateLabel, money, newLine, newReceipt, normalizeWorkspace, paymentMethods,
  plots, receiptError, receiptValidation, totalLineCents, varieties,
  type Receipt, type ReceiptWorkspace,
} from "../lib/receipts";

const inputClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base";
const statusLabels = { draft: "טיוטה", confirmed: "מאושר", cancelled: "מבוטל" };

export default function Receipts({ onChanged, onDirtyChange }: { onChanged: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const { profile } = useAuth();
  const [workspace, setWorkspace] = useState<ReceiptWorkspace | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [listStatus, setListStatus] = useState("confirmed");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("get_receipt_workspace");
      if (error) throw error;
      const result = normalizeWorkspace(data as ReceiptWorkspace);
      setWorkspace(result);
      return result;
    } catch (error) {
      console.error("Receipt workspace failed", error);
      setWorkspace(null);
      setMessage("לא ניתן לטעון תקבולים. נסה שוב. בהפעלה ראשונה יש להשלים את הגדרת מסד הנתונים לתקבולים.");
      return null;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const update = (next: Receipt) => { setReceipt(next); setDirty(true); onDirtyChange(true); };
  const open = (next: Receipt | null) => {
    if (dirty && !window.confirm("יש שינויים שלא נשמרו. לעזוב אותם?")) return;
    setReceipt(next ? structuredClone(next) : null); setDirty(false); onDirtyChange(false); setMessage("");
  };
  const save = async (finalize: boolean) => {
    if (!receipt || busy) return;
    if (finalize) {
      const validation = receiptValidation(receipt);
      if (validation) { setMessage(validation); return; }
      const text = [receipt.version ? "לעדכן ולאשר את התקבול?" : "לאשר את התקבול?",
        `תאריך: ${dateLabel(receipt.payment_date)}`, `סכום: ${money(cents(receipt.amount))}`,
        `שורות פירוט: ${receipt.lines.length}`, `הפרש מהפירוט: ${money(cents(receipt.amount) - totalLineCents(receipt))}`,
        "המשקלים המאושרים ייכללו בדשבורד."].join("\n");
      if (!window.confirm(text)) return;
    }
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.rpc("save_farm_receipt", { payload: receipt, finalize });
      if (error) throw error;
      setReceipt(null); setDirty(false); onDirtyChange(false);
      setMessage(finalize ? "התקבול אושר ונשמר." : "הטיוטה נשמרה. היא עדיין אינה נכללת במשקלים בדשבורד.");
      await load(); onChanged();
    } catch (error) {
      console.error("Receipt save failed", error);
      setMessage(receiptError(error && typeof error === "object" && "message" in error ? String(error.message) : ""));
    } finally { setBusy(false); }
  };
  const cancel = async (item: Receipt) => {
    if (busy) return;
    const reason = window.prompt("מה הסיבה לביטול התקבול?");
    if (!reason?.trim()) return;
    if (!window.confirm(`לבטל את התקבול מ־${dateLabel(item.payment_date)} על סך ${money(cents(item.amount))}?\nהביטול יסיר את המשקלים מהדשבורד וישחרר את המיכלים לשיוך מחדש.`)) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.rpc("cancel_farm_receipt", { receipt_id: item.id, expected_version: item.version, reason });
      if (error) throw error;
      setMessage("התקבול בוטל. הפירוט נשמר בהיסטוריה.");
      await load(); onChanged();
    } catch (error) {
      setMessage(receiptError(error && typeof error === "object" && "message" in error ? String(error.message) : ""));
    } finally { setBusy(false); }
  };

  const remove = async (item: Receipt) => {
    if (busy || loading || !["draft", "cancelled"].includes(item.status)) return;
    if (!window.confirm(`למחוק לצמיתות את התקבול בסטטוס ${statusLabels[item.status]} מ־${dateLabel(item.payment_date)} על סך ${money(cents(item.amount))}?\nהתקבול וכל שורותיו יימחקו מהרשימה. הפעולה אינה ניתנת לביטול.`)) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.rpc("delete_farm_receipt", { receipt_id: item.id, expected_version: item.version });
      if (error) throw error;
      setMessage("התקבול נמחק.");
      await load(); onChanged();
    } catch (error) {
      setMessage(receiptError(error && typeof error === "object" && "message" in error ? String(error.message) : ""));
    } finally { setBusy(false); }
  };

  if (profile.role !== "admin") return <p role="alert">מסך התקבולים זמין למנהל בלבד.</p>;
  const original = workspace?.receipts.find((item) => item.id === receipt?.id);
  const history = workspace?.receipts.filter((item) => listStatus === "all" || item.status === listStatus) || [];
  const difference = receipt ? cents(receipt.amount) - totalLineCents(receipt) : 0;

  return <section className="space-y-4 text-zinc-900">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-2xl font-bold">תקבולים</h2>
      <button type="button" disabled={busy || loading || !workspace} onClick={() => open(newReceipt())} className="min-h-11 rounded-xl bg-zinc-900 px-4 text-white disabled:opacity-50">תקבול חדש</button>
    </div>
    {message && <p role="status" className="whitespace-pre-line rounded-xl border border-zinc-200 bg-white p-4 text-sm">{message}</p>}
    {loading && <p role="status">טוען תקבולים ושיווקים…</p>}
    {!workspace && !loading && <button type="button" className="min-h-11 underline" onClick={() => { void load(); }}>נסה שוב</button>}

    {receipt && workspace && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(true); }}>
      <fieldset disabled={busy || loading} className="space-y-4 disabled:opacity-60">
        <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4">
          <h3 className="text-lg font-semibold">{original ? "עריכת תקבול" : "פרטי התקבול"}</h3>
          <label className="block text-sm">סוחר<select required value={receipt.trader_id} className={inputClass} onChange={(e) => {
            if (receipt.lines.some((line) => line.allocations.length) && !window.confirm("שינוי הסוחר ינקה את כל השיוכים בתקבול. להמשיך?")) return;
            update({ ...receipt, trader_id: e.target.value, lines: receipt.lines.map((line) => ({ ...line, allocations: [] })) });
          }}>{workspace.traders.map((trader) => <option key={trader.id} value={trader.id}>{trader.name}</option>)}</select></label>
          <label className="block text-sm">אמצעי תשלום<select value={receipt.method} onChange={(e) => update({ ...receipt, method: e.target.value as Receipt["method"] })} className={inputClass}>{Object.entries(paymentMethods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            <label className="min-w-0 text-sm">{receipt.method === "cheque" ? "תאריך פירעון ההמחאה" : receipt.method === "bank" ? "תאריך ההעברה" : "תאריך קבלת המזומן"}<input required type="date" value={receipt.payment_date} onChange={(e) => update({
              ...receipt,
              payment_date: e.target.value,
              received_date: !original && receipt.method === "cheque" && !receipt.received_date
                ? e.target.value : receipt.received_date,
            })} className={inputClass} /></label>
            {receipt.method === "cheque" && <label className="min-w-0 text-sm">תאריך קבלת ההמחאה (רשות)<input type="date" value={receipt.received_date} onChange={(e) => update({ ...receipt, received_date: e.target.value })} className={inputClass} /></label>}
            <label className="min-w-0 text-sm">סכום התקבול בפועל (₪)<input type="number" inputMode="decimal" min="0" step="0.01" value={receipt.amount} onChange={(e) => update({ ...receipt, amount: e.target.value })} className={inputClass} /></label>
            <label className="min-w-0 text-sm">{receipt.method === "cheque" ? "מספר המחאה (רשות)" : "אסמכתה (רשות)"}<input maxLength={200} value={receipt.reference} onChange={(e) => update({ ...receipt, reference: e.target.value })} className={inputClass} /></label>
          </div>
          <label className="block text-sm">הערות<textarea maxLength={4000} value={receipt.notes} onChange={(e) => update({ ...receipt, notes: e.target.value })} className={inputClass} /></label>
        </div>
        {receipt.lines.map((line, index) => <ReceiptLineEditor key={line.id} receipt={receipt} line={line} position={index + 1} workspace={workspace} original={original}
          onChange={(next) => update({ ...receipt, lines: receipt.lines.map((item) => item.id === line.id ? next : item) })}
          onRemove={() => update({ ...receipt, lines: receipt.lines.filter((item) => item.id !== line.id) })} />)}
        <button type="button" disabled={receipt.lines.length >= 100} onClick={() => update({ ...receipt, lines: [...receipt.lines, newLine()] })} className="min-h-11 w-full rounded-xl border border-zinc-300 bg-white p-3">הוסף שורת פירוט</button>
        <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-4 text-sm">
          <h3 className="font-semibold">סיכום לפני שמירה</h3>
          <p>סכום שורות הפירוט: {money(totalLineCents(receipt))}</p>
          <p>סכום התקבול: {money(cents(receipt.amount))}</p>
          <p className={difference ? "text-amber-800" : "text-green-800"}>הפרש: {money(difference)}</p>
          {(difference !== 0 || receipt.adjustment_reason) && <label className="block">הסבר להפרש<textarea maxLength={2000} value={receipt.adjustment_reason} onChange={(e) => update({ ...receipt, adjustment_reason: e.target.value })} className={inputClass} /></label>}
          <p className="text-xs text-zinc-500">טיוטות אינן תופסות מיכלים ואינן נכללות בדשבורד. אישור סופי דורש שיוך מלא של המיכלים והנטו.</p>
        </div>
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          {original?.status !== "confirmed" && <button type="button" onClick={() => { void save(false); }} className="min-h-11 rounded-xl border border-zinc-300 bg-white p-3">שמור טיוטה</button>}
          <button type="submit" className="min-h-11 rounded-xl bg-green-800 p-3 text-white">{busy ? "שומר…" : original?.status === "confirmed" ? "עדכון ואישור התקבול" : "אישור סופי ושמירה"}</button>
          <button type="button" onClick={() => open(null)} className="min-h-11 rounded-xl border border-zinc-300 p-3">סגור עריכה</button>
        </div>
      </fieldset>
    </form>}

    {workspace && !receipt && <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">תקבולים קודמים</h3>
        <label className="text-sm">מצב<select value={listStatus} onChange={(e) => setListStatus(e.target.value)} className={inputClass}><option value="all">הכל</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <button type="button" disabled={busy || loading} onClick={() => { void load(); }} className="min-h-11 underline">רענון רשימה</button>
      {!loading && history.length === 0 && <p className="rounded-xl bg-white p-4 text-sm">אין תקבולים להצגה.</p>}
      {history.map((item) => <details key={item.id} className="rounded-2xl border border-zinc-200 bg-white">
        <summary className="min-h-11 cursor-pointer p-4 text-sm font-semibold">{dateLabel(item.payment_date)} · {money(cents(item.amount))} · {statusLabels[item.status]}</summary>
        <div className="space-y-3 px-4 pb-4 text-sm">
          <p>{workspace.traders.find((trader) => trader.id === item.trader_id)?.name} · {paymentMethods[item.method]}</p>
          {item.received_date && <p>התקבל בתאריך: {dateLabel(item.received_date)}</p>}
          {item.reference && <p className="break-words">אסמכתה: {item.reference}</p>}
          {item.notes && <p className="whitespace-pre-line break-words">{item.notes}</p>}
          <Documents kind="receipt" id={item.id} onBusyChange={(working) => { setBusy(working); onDirtyChange(working); }} />
          <p>סכום הפירוט: {money(totalLineCents(item))} · הפרש: {money(cents(item.amount) - totalLineCents(item))}</p>
          {item.adjustment_reason && <p className="break-words">הסבר להפרש: {item.adjustment_reason}</p>}
          {item.lines.map((line, index) => <div key={line.id} className="space-y-1 rounded-xl bg-zinc-50 p-3">
            <p className="font-medium">שורה {index + 1} · {dateLabel(line.trader_date)} · {varieties[line.variety_id]}</p>
            <p>{line.containers} מיכלים · ברוטו {line.gross_weight} ק״ג · נטו {line.net_weight} ק״ג</p>
            <p>משקל מיכל {line.tare_weight} ק״ג · מחיר לק״ג ₪{line.price_per_kg} · סכום {money(cents(line.amount))}</p>
            {line.allocations.map((allocation) => {
              const shipment = workspace.shipments.find((record) => record.id === allocation.harvest_event_id);
              return <p key={allocation.harvest_event_id} className="text-xs text-zinc-600">שיווק {shipment ? `${dateLabel(shipment.harvest_date)} · ${plots[shipment.plot_id] || "חלקה לא ידועה"}` : allocation.harvest_event_id}: {allocation.containers} מיכלים · {allocation.net_weight} ק״ג נטו</p>;
            })}
          </div>)}
          {item.status === "cancelled" ? <p className="text-red-700">סיבת ביטול: {item.cancellation_reason}</p> : <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || loading} onClick={() => open(item)} className="min-h-11 rounded-lg border border-zinc-300 px-3">עריכת תקבול</button>
            <button type="button" disabled={busy || loading} onClick={() => { void cancel(item); }} className="min-h-11 rounded-lg border border-red-200 px-3 text-red-700">ביטול תקבול</button>
          </div>}
          {(item.status === "draft" || item.status === "cancelled") && <button type="button" disabled={busy || loading} onClick={() => { void remove(item); }} className="min-h-11 rounded-lg border border-red-200 px-3 text-red-700">מחיקת תקבול</button>}
        </div>
      </details>)}
    </>}
  </section>;
}
