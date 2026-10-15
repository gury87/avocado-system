"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthGate";

type Document = { id: string; storage_path: string; file_name: string; file_size: number };
const types: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export default function Documents({ kind, id, onBusyChange }: { kind: "receipt" | "shipment"; id: string; onBusyChange?: (busy: boolean) => void }) {
  const { profile } = useAuth();
  const [expanded, setExpanded] = useState(false), [files, setFiles] = useState<Document[]>([]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const column = kind === "receipt" ? "receipt_id" : "shipment_id";
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const { data, error } = await supabase.from("farm_documents").select("id,storage_path,file_name,file_size").eq(column, id).order("created_at");
      if (error) throw error;
      setFiles(data || []);
    } catch { setError("לא ניתן לטעון מסמכים. בדוק את החיבור ונסה שוב."); }
    finally { setLoading(false); }
  }, [column, id]);
  useEffect(() => {
    if (!expanded || profile.role !== "admin") return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [expanded, load, profile.role]);
  if (profile.role !== "admin") return null;
  const storage = supabase.storage.from("farm-documents");
  const working = (value: boolean) => { setBusy(value); onBusyChange?.(value); };
  return <div className="min-w-0 rounded-xl border border-zinc-200 p-3 text-sm">
    <button type="button" disabled={busy} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="min-h-11 underline">מסמכים מצורפים</button>
    {expanded && <div className="space-y-3">
      <p className="text-xs text-zinc-500">תמונות או PDF עד 10 מג״ב לקובץ. המסמכים זמינים למנהל בלבד.</p>
      <label className="block">הוספת מסמך<input aria-label="הוספת מסמך" disabled={busy || loading} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="mt-2 block w-full min-w-0 text-xs" onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (!types[file.type] || !file.size || file.size > 10485760) { setError("יש לבחור תמונה או PDF עד 10 מג״ב."); return; }
        working(true); setError("");
        const path = `${kind}/${id}/${crypto.randomUUID()}.${types[file.type]}`;
        let uploaded = false;
        try {
          const result = await storage.upload(path, file, { contentType: file.type, upsert: false });
          if (result.error) throw result.error;
          uploaded = true;
          const { error } = await supabase.from("farm_documents").insert({ [column]: id, storage_path: path, file_name: file.name.slice(0, 255), mime_type: file.type, file_size: file.size });
          if (error) throw error;
          await load();
        } catch {
          if (uploaded) {
            // A lost insert response must not delete a successfully linked file.
            const linked = await supabase.from("farm_documents").select("id").eq("storage_path", path).maybeSingle();
            if (linked.data) { await load(); working(false); return; }
            if (!linked.error) await storage.remove([path]);
          }
          setError("העלאת המסמך נכשלה. בדוק את החיבור ונסה שוב.");
        } finally { working(false); }
      }} /></label>
      {loading && <p role="status">טוען מסמכים…</p>}
      {!loading && !files.length && !error && <p>אין מסמכים מצורפים.</p>}
      {files.map((file) => <div key={file.id} className="flex min-w-0 items-start gap-2">
        <button type="button" disabled={busy} className="min-h-11 min-w-0 flex-1 break-words text-right text-blue-700 underline" onClick={async () => {
          working(true); setError("");
          try {
            const { data, error } = await storage.createSignedUrl(file.storage_path, 60);
            if (error || !data) throw error;
            // Navigation after async signing works on mobile without pop-up permissions.
            window.location.assign(data.signedUrl);
          } catch { setError("לא ניתן לפתוח את המסמך. נסה שוב."); }
          finally { working(false); }
        }}>{file.file_name}</button>
        <button type="button" disabled={busy} aria-label={`מחק מסמך ${file.file_name}`} className="min-h-11 shrink-0 text-red-700" onClick={async () => {
          if (!window.confirm(`למחוק לצמיתות את המסמך ${file.file_name}?`)) return;
          working(true); setError("");
          try {
            const result = await storage.remove([file.storage_path]); if (result.error) throw result.error;
            const { error } = await supabase.from("farm_documents").delete().eq("id", file.id); if (error) throw error;
            await load();
          } catch { setError("המחיקה לא הושלמה. נסה שוב; ייתכן שהקובץ הוסר והרשומה עדיין ממתינה למחיקה."); }
          finally { working(false); }
        }}>מחיקה</button>
      </div>)}
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>}
  </div>;
}
