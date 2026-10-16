"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthGate";
import { useCatalog } from "./FarmCatalog";
import type { CatalogEntry, CatalogKind } from "../lib/catalog";

const inputClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-2 text-base";
function failure(cause: unknown) {
  const message = cause && typeof cause === "object" && "message" in cause ? String(cause.message) : "";
  return message.includes("STALE_SETTINGS") ? "הנתונים השתנו אצל משתמש אחר. רענן ונסה שוב."
    : message.includes("LAST_ACTIVE_CATALOG") ? "יש להשאיר לפחות רשומה פעילה אחת בכל רשימה."
    : message.includes("DUPLICATE_CATALOG") ? "כבר קיימת רשומה בשם זה ברשימה. יש לבחור שם אחר."
    : message.includes("FORBIDDEN") ? "רק מנהל פעיל רשאי לשנות הגדרות."
    : "השמירה נכשלה. בדוק את הערכים והחיבור ונסה שוב.";
}
export default function FarmSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { profile } = useAuth(), { catalog, refresh } = useCatalog();
  const [tab, setTab] = useState<CatalogKind>("plots");
  const [settings, setSettings] = useState({ days: String(catalog.settings.overdue_days), loss: String(catalog.settings.loss_warning_percent), small: String(catalog.settings.picking_rate_small), large: String(catalog.settings.picking_rate_large), version: catalog.settings.version });
  const [entry, setEntry] = useState<{ id: string | null; name: string; active: boolean; dunam: string; version: number } | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(()=>{
    if(dirty||entry)return;
    const timer=window.setTimeout(()=>setSettings({days:String(catalog.settings.overdue_days),loss:String(catalog.settings.loss_warning_percent),small:String(catalog.settings.picking_rate_small),large:String(catalog.settings.picking_rate_large),version:catalog.settings.version}),0);
    return()=>window.clearTimeout(timer);
  },[catalog.settings,dirty,entry]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue=""; } };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);
  if (profile.role !== "admin") return null;
  const mark = () => { setDirty(true); onDirtyChange(true); };
  const canLeave = () => !dirty || window.confirm("יש שינויים בהגדרות שלא נשמרו. לעזוב אותם?");
  const clear = () => { setDirty(false); onDirtyChange(false); setEntry(null); setSettings({ days:String(catalog.settings.overdue_days),loss:String(catalog.settings.loss_warning_percent),small:String(catalog.settings.picking_rate_small),large:String(catalog.settings.picking_rate_large),version:catalog.settings.version }); };
  const open = (e?: CatalogEntry) => { if (!canLeave() || busy) return; clear(); setMessage(""); setEntry({ id:e?.id || null,name:e?.name || "",active:e?.active ?? true,dunam:e?.dunam == null ? "" : String(e.dunam),version:e?.version || 0 }); };
  return <section className="space-y-4 text-zinc-900">
    <h2 className="text-2xl font-bold">הגדרות המשק</h2>
    <p className="text-sm text-zinc-600">ניהול למנהל בלבד. הוצאה משימוש מסתירה רשומה מבחירה חדשה ושומרת את ההיסטוריה.</p>
    {message && <p role="status" className="rounded-xl bg-white p-3">{message}</p>}
    <button type="button" disabled={busy} className="min-h-11 underline" onClick={async () => { if (!canLeave()) return; setEntry(null); if (await refresh()) { setMessage("הנתונים רועננו."); setDirty(false);onDirtyChange(false); } }}>רענון הגדרות</button>
    <form className="rounded-xl border border-zinc-200 bg-white p-4" onSubmit={async (event) => {
      event.preventDefault(); if (busy) return; setBusy(true); onDirtyChange(true); setMessage("");
      try {
        const { error }=await supabase.rpc("admin_save_farm_settings_with_picking",{expected_version:settings.version,new_overdue_days:Number(settings.days),new_loss_warning_percent:Number(settings.loss),new_picking_rate_small:Number(settings.small),new_picking_rate_large:Number(settings.large)});
        if(error) throw error;
        const ok=await refresh(); setSettings({...settings,version:settings.version+1});setDirty(false);onDirtyChange(false);setMessage(ok?"הפרמטרים נשמרו.":"הפרמטרים נשמרו. יש לרענן את המסך לטעינת הערכים העדכניים.");
      } catch(cause){setMessage(failure(cause));onDirtyChange(dirty);} finally{setBusy(false);}
    }}>
      <h3 className="mb-3 text-lg font-semibold">פרמטרים</h3>
      <fieldset disabled={busy || !!entry} className="space-y-3">
        <label className="block text-sm">סימון שיווק פתוח לאחר מספר ימים<input required type="number" min="0" max="3650" step="1" value={settings.days} className={inputClass} onChange={(e)=>{setSettings({...settings,days:e.target.value});mark();}} /></label>
        <p className="text-xs text-zinc-500">מסומן רק שיווק עם יתרת מיכלים שלא שויכו לתקבול מאושר, שגילו גדול מהסף.</p>
        <label className="block text-sm">סף סימון פחת (%)<input required type="number" min="0" max="100" step="0.1" value={settings.loss} className={inputClass} onChange={(e)=>{setSettings({...settings,loss:e.target.value});mark();}} /></label>
        <p className="text-xs text-zinc-500">פחת מחושב מהברוטו לאחר ניכוי משקל המיכלים. הסף הוא כלי סימון שניתן להתאמה.</p>
        {([['small','קטן'],['large','גדול']] as const).map(([key,label])=><label key={key} className="block text-sm">עלות קטיף למיכל {label} (₪)<input required type="number" min="0" max="1000000" step="0.01" value={settings[key]} className={inputClass} onChange={(e)=>{setSettings({...settings,[key]:e.target.value});mark();}} /></label>)}
        <p className="text-xs text-zinc-500">תעריפי הקטיף יחולו על שיווקים חדשים בלבד. לכל שיווק נשמר התעריף שלו; שינוי כמות בשיווק קיים משתמש בתעריף ההיסטורי.</p>
        <button type="submit" className="min-h-11 rounded-lg bg-zinc-900 px-3 text-white">{busy?"שומר…":"שמירת פרמטרים"}</button>
      </fieldset>
    </form>
    <div className="flex gap-2">{([{kind:"plots",label:"חלקות"},{kind:"traders",label:"סוחרים"},{kind:"varieties",label:"זנים"}] as const).map(({kind,label})=><button key={kind} disabled={busy} type="button" aria-pressed={tab===kind} className={`min-h-11 flex-1 rounded-lg p-2 ${tab===kind?"bg-zinc-900 text-white":"bg-white"}`} onClick={()=>{if(!canLeave())return;clear();setTab(kind);}}>{label}</button>)}</div>
    <button type="button" disabled={busy} className="min-h-11 rounded-lg border bg-white px-3" onClick={()=>open()}>הוספת {tab==="plots"?"חלקה":tab==="traders"?"סוחר":"זן"}</button>
    {entry && <form className="rounded-xl border border-zinc-200 bg-white p-4" onSubmit={async(event)=>{
      event.preventDefault();if(busy)return;setBusy(true);onDirtyChange(true);setMessage("");
      try{
        const {error}=await supabase.rpc("admin_save_catalog",{kind:tab,target_id:entry.id,expected_version:entry.version,new_name:entry.name,new_active:entry.active,new_dunam:tab==="plots"&&entry.dunam!==""?Number(entry.dunam):null});
        if(error)throw error;
        const ok=await refresh();setEntry(null);setDirty(false);onDirtyChange(false);setMessage(ok?"הרשומה נשמרה.":"הרשומה נשמרה. יש לרענן את המסך לטעינת הרשימות.");
      }catch(cause){setMessage(failure(cause));onDirtyChange(dirty);}finally{setBusy(false);}
    }}>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">שם<input required maxLength={100} value={entry.name} className={inputClass} onChange={(e)=>{setEntry({...entry,name:e.target.value});mark();}} /></label>
        {tab==="plots"&&<label className="block text-sm">שטח בדונם<input type="number" min="0" max="1000000" step="0.001" value={entry.dunam} className={inputClass} onChange={(e)=>{setEntry({...entry,dunam:e.target.value});mark();}} /><span className="text-xs text-zinc-500">שטח ריק או אפס יסומן כחסר בדוח לדונם.</span></label>}
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={entry.active} onChange={(e)=>{setEntry({...entry,active:e.target.checked});mark();}} />פעיל לבחירה חדשה</label>
        <div className="flex gap-2"><button type="submit" className="min-h-11 rounded-lg bg-green-800 px-3 text-white">שמירת רשומה</button><button type="button" className="min-h-11 rounded-lg border px-3" onClick={()=>{if(canLeave())clear();}}>ביטול</button></div>
      </fieldset>
    </form>}
    <div className="space-y-2">{catalog[tab].map((e)=><div key={e.id} className="flex items-center justify-between gap-3 rounded-xl bg-white p-3"><div className="min-w-0"><p className="break-words font-medium">{e.name}</p><p className="text-xs text-zinc-600">{e.active?"פעיל":"לא פעיל"}{tab==="plots"?` · ${e.dunam && e.dunam>0?e.dunam+" דונם":"שטח חסר"}`:""}</p></div><button type="button" disabled={busy} className="min-h-11 rounded-lg border px-3" aria-label={`ערוך ${e.name}`} onClick={()=>open(e)}>עריכה</button></div>)}</div>
  </section>;
}
