"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { catalogNames, type FarmCatalog } from "../lib/catalog";
import { localToday } from "../lib/receipts";

const Context = createContext<{ catalog: FarmCatalog; refresh: () => Promise<boolean>; plots: Record<string,string>; varieties: Record<string,string> } | null>(null);
export function useCatalog() { const value = useContext(Context); if (!value) throw new Error("Farm catalog missing"); return value; }
export function useFarmToday(){
  const[today,setToday]=useState(localToday);
  useEffect(()=>{const timer=window.setInterval(()=>setToday(localToday()),60000);return()=>window.clearInterval(timer);},[]);
  return today;
}
export default function FarmCatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<FarmCatalog | null>(null), [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("get_farm_catalog"); if (error) throw error;
      const raw = data as FarmCatalog;
      setCatalog({ settings: { ...raw.settings, overdue_days: Number(raw.settings.overdue_days), loss_warning_percent: Number(raw.settings.loss_warning_percent) },
        plots: raw.plots.map((e) => ({ ...e, id: String(e.id), dunam: e.dunam == null ? null : Number(e.dunam) })),
        traders: raw.traders.map((e) => ({ ...e, id: String(e.id) })), varieties: raw.varieties.map((e) => ({ ...e, id: String(e.id) })) });
      setError(false); return true;
    } catch { setError(true); return false; }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    const focus=()=>{void refresh();};window.addEventListener("focus",focus);
    return () => {window.clearTimeout(timer);window.removeEventListener("focus",focus);};
  }, [refresh]);
  if (!catalog) return <div className="p-6 text-right" dir="rtl">{error ? <><p role="alert">לא ניתן לטעון את נתוני המשק.</p><button type="button" className="min-h-11 underline" onClick={() => { void refresh(); }}>נסה שוב</button></> : <p role="status">טוען נתוני משק…</p>}</div>;
  return <Context.Provider value={{ catalog, refresh, plots: catalogNames(catalog.plots), varieties: catalogNames(catalog.varieties) }}>{children}</Context.Provider>;
}
