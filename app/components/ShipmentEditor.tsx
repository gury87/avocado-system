"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { dateLabel } from "../lib/receipts";
import { useCatalog } from "./FarmCatalog";
import { catalogOptions } from "../lib/catalog";
import { useAuth } from "./AuthGate";
import Documents from "./Documents";

export type EditableShipment = {
  id: string; date: string; variety: string; plot: string; containers: number;
  varietyId: number; plotId: number; editVersion: number; traderId: string;
};

export default function ShipmentEditor({ shipment, onClose, onSaved, onDirtyChange }: {
  shipment: EditableShipment; onClose: () => void; onSaved: (updated: EditableShipment) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { profile } = useAuth();
  const { catalog, plots, varieties } = useCatalog();
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({ date: shipment.date, variety: String(shipment.varietyId), plot: String(shipment.plotId), containers: String(shipment.containers), trader: shipment.traderId });
  const [traders, setTraders] = useState<{ id: string; name: string }[]>([]);
  const [loadingTraders, setLoadingTraders] = useState(true), [tradersError, setTradersError] = useState(false);
  const loadTraders = useCallback(async () => {
    setLoadingTraders(true); setTradersError(false);
    try {
      const { data, error } = await supabase.rpc("get_shipment_traders");
      if (error) throw error;
      setTraders((data || []).map((trader: { id: string; name: string }) => ({ ...trader, id: String(trader.id),name:catalog.traders.find((e)=>e.id===String(trader.id))?.name||trader.name })).filter((trader:{id:string})=>catalog.traders.some((e)=>e.id===trader.id&&(e.active||e.id===shipment.traderId))));
    } catch { setTradersError(true); }
    finally { setLoadingTraders(false); }
  }, [catalog.traders,shipment.traderId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadTraders(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadTraders]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => { root.style.overflow = previousOverflow; };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const close = () => {
    if (busy || (dirty && !window.confirm("לבטל את השינויים בשיווק?"))) return;
    onDirtyChange(false); onClose();
  };
  const inputClass = "mt-1 min-h-11 w-full min-w-0 max-w-full rounded-lg border border-zinc-300 bg-white p-3 text-base";
  const update = (key: keyof typeof form, value: string) => { setForm({ ...form, [key]: value }); setDirty(true); onDirtyChange(true); };
  return <dialog ref={dialog} dir="rtl" aria-labelledby="shipment-edit-title" onCancel={(event) => { event.preventDefault(); close(); }}
    style={{ width: "calc(100vw - 2rem)", maxWidth: "28rem", right: "max(1rem, calc((100vw - 28rem) / 2))" }}
    className="fixed inset-auto top-1/2 m-0 -translate-y-1/2 min-w-0 max-h-[90dvh] overflow-x-hidden overflow-y-auto rounded-2xl bg-white p-5 text-zinc-900 backdrop:bg-black/40">
    <form className="min-w-0 space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !["admin", "worker"].includes(profile.role)) return;
      if (loadingTraders || tradersError || !traders.some((trader) => trader.id === form.trader)) { setError("יש לבחור סוחר מהרשימה לפני השמירה."); return; }
      if (!window.confirm(["לשמור את השינויים בשיווק?", `סוחר: ${traders.find((trader) => trader.id === form.trader)?.name}`, `תאריך: ${dateLabel(form.date)}`, `זן: ${varieties[form.variety]}`, `חלקה: ${plots[form.plot]}`, `מיכלים: ${form.containers}`].join("\n"))) return;
      setBusy(true); setError("");
      try {
        const { data, error: saveError } = await supabase.rpc("edit_farm_shipment_with_trader", {
          target_id: shipment.id, expected_version: shipment.editVersion, new_date: form.date,
          new_variety_id: Number(form.variety), new_plot_id: Number(form.plot), new_containers: Number(form.containers),
          new_trader_id: form.trader,
        });
        if (saveError) throw saveError;
        onDirtyChange(false);
        await onSaved({ ...shipment, date: form.date, varietyId: Number(form.variety), plotId: Number(form.plot),
          variety: varieties[form.variety], plot: plots[form.plot], containers: Number(form.containers), editVersion: data.edit_version, traderId: form.trader });
        onClose();
      } catch (cause) {
        const message = cause && typeof cause === "object" && "message" in cause ? String(cause.message) : "";
        setError(message.includes("LINKED_TRADER") ? "לא ניתן לשנות סוחר בשיווק המשויך לטיוטה או לתקבול מאושר. יש לתקן או לבטל את השיוך בתקבול תחילה."
          : message.includes("INVALID_TRADER") ? "הסוחר שנבחר אינו זמין. סגור את העריכה ופתח אותה מחדש."
          : message.includes("INACTIVE_CATALOG") ? "החלקה או הזן הוצאו משימוש. בחר ערך פעיל ורענן את הנתונים."
          : message.includes("LINKED_VARIETY") ? "לא ניתן לשנות זן בשיווק המשויך לתקבול פעיל. יש לתקן את השיוך בתקבול תחילה."
          : message.includes("BELOW_PAID_CONTAINERS") ? "לא ניתן להקטין את הכמות מתחת למספר המיכלים שכבר שויכו לתקבולים מאושרים."
          : message.includes("STALE_SHIPMENT") ? "השיווק השתנה מאז שפתחת אותו. סגור את העריכה, רענן ופתח אותו מחדש."
          : message.includes("FORBIDDEN") ? "אין הרשאה לערוך שיווקים בחשבון זה."
          : "השמירה נכשלה. בדוק את הנתונים ואת החיבור ונסה שוב.");
      } finally { setBusy(false); }
    }}>
      <h2 id="shipment-edit-title" className="text-xl font-semibold">עריכת שיווק</h2>
      <fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-50">
        <label className="block text-sm">סוחר<select required disabled={loadingTraders || tradersError} value={form.trader} onChange={(e) => update("trader", e.target.value)} className={inputClass}>
          <option value="">{loadingTraders ? "טוען סוחרים…" : "בחר סוחר"}</option>
          {form.trader && !traders.some((trader) => trader.id === form.trader) && <option value={form.trader}>{loadingTraders ? "טוען סוחר…" : `סוחר ${form.trader}`}</option>}
          {traders.map((trader) => <option key={trader.id} value={trader.id}>{trader.name}</option>)}
        </select></label>
        {tradersError && <p role="alert" className="text-sm text-red-700">לא ניתן לטעון סוחרים. <button type="button" onClick={() => { void loadTraders(); }} className="min-h-11 underline">נסה שוב</button></p>}
        <label className="block text-sm">תאריך שיווק<input required type="date" value={form.date} onChange={(e) => update("date", e.target.value)} className={inputClass} /></label>
        <label className="block text-sm">זן<select value={form.variety} onChange={(e) => update("variety", e.target.value)} className={inputClass}>{catalogOptions(catalog.varieties,String(shipment.varietyId)).map((e) => <option key={e.id} value={e.id}>{e.name}{e.active?"":" (לא פעיל)"}</option>)}</select></label>
        <label className="block text-sm">חלקה<select value={form.plot} onChange={(e) => update("plot", e.target.value)} className={inputClass}>{catalogOptions(catalog.plots,String(shipment.plotId)).map((e) => <option key={e.id} value={e.id}>{e.name}{e.active?"":" (לא פעיל)"}</option>)}</select></label>
        <label className="block text-sm">מספר מיכלים<input required type="number" inputMode="numeric" min="1" max="1000000" step="1" value={form.containers} onChange={(e) => update("containers", e.target.value)} className={inputClass} /></label>
      </fieldset>
      <p className="text-xs text-zinc-500">שינוי תאריך או חלקה יעדכן גם את פילוח הנתונים בדשבורד. שיוכים לתקבולים נשמרים.</p>
      <Documents kind="shipment" id={shipment.id} onBusyChange={(working) => { setBusy(working); onDirtyChange(working || dirty); }} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <button disabled={busy || loadingTraders || tradersError} type="submit" className="min-h-11 rounded-xl bg-zinc-900 p-3 text-white disabled:opacity-50">{busy ? "שומר…" : "שמור שינויים"}</button>
        <button disabled={busy} type="button" onClick={close} className="min-h-11 rounded-xl border border-zinc-300 p-3">ביטול</button>
      </div>
    </form>
  </dialog>;
}
