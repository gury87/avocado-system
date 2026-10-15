"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthGate";
import PhotoEditor from "./PhotoEditor";
import PhotoViewer, { PhotoThumbnail } from "./PhotoViewer";

type Document = { id: string; storage_path: string; file_name: string; file_size: number; mime_type?: string };
const isPhoto = (file: Document) => file.mime_type?.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.storage_path);
export default function Documents({ kind, id, onBusyChange }: { kind: "receipt" | "shipment"; id: string; onBusyChange?: (busy: boolean) => void }) {
  const { profile } = useAuth();
  const [expanded, setExpanded] = useState(false), [files, setFiles] = useState<Document[]>([]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null), [viewing, setViewing] = useState<Document | null>(null);
  const column = kind === "receipt" ? "receipt_id" : "shipment_id";
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const { data, error } = await supabase.from("farm_documents").select("id,storage_path,file_name,file_size,mime_type").eq(column, id).order("created_at");
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
  useEffect(() => {
    if (!pendingPhoto) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pendingPhoto]);
  if (profile.role !== "admin") return null;
  const storage = supabase.storage.from("farm-documents");
  const working = (value: boolean) => { setBusy(value); onBusyChange?.(value); };
  const uploadPhoto = async (file: File) => {
    setError("");
    const path = `${kind}/${id}/${crypto.randomUUID()}.jpg`;
    let uploaded = false;
    try {
      const result = await storage.upload(path, file, { contentType: file.type, upsert: false });
      if (result.error) throw result.error;
      uploaded = true;
      const { error } = await supabase.from("farm_documents").insert({ [column]: id, storage_path: path, file_name: file.name.slice(0, 255), mime_type: file.type, file_size: file.size });
      if (error) throw error;
      await load(); return true;
    } catch {
      if (uploaded) {
        const linked = await supabase.from("farm_documents").select("id").eq("storage_path", path).maybeSingle();
        if (linked.data) { await load(); return true; }
        if (!linked.error) await storage.remove([path]);
      }
      setError("העלאת התמונה נכשלה. בדוק את החיבור ונסה שוב."); return false;
    }
  };
  return <div className="min-w-0 rounded-xl border border-zinc-200 p-3 text-sm">
    {pendingPhoto && <PhotoEditor file={pendingPhoto} onCancel={() => { setPendingPhoto(null); working(false); }} onSave={async (file) => {
      const saved = await uploadPhoto(file);
      if (saved) { setPendingPhoto(null); working(false); }
      return saved;
    }} />}
    {viewing && <PhotoViewer path={viewing.storage_path} name={viewing.file_name} onClose={() => setViewing(null)} />}
    <button type="button" disabled={busy} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="min-h-11 underline">מסמכים מצורפים</button>
    {expanded && <div className="space-y-3">
      <p className="text-xs text-zinc-500">אפשר לצלם או לבחור תמונה, לסובב ולחתוך לפני ההעלאה. התמונות זמינות למנהל בלבד.</p>
      <label className="block">הוספת תמונה<input aria-label="הוספת תמונה" disabled={busy || loading} type="file" accept="image/jpeg,image/png,image/webp" className="mt-2 block w-full min-w-0 text-xs" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (!(file.type ? ["image/jpeg", "image/png", "image/webp"].includes(file.type) : /\.(jpe?g|png|webp)$/i.test(file.name)) || !file.size || file.size > 26214400) { setError("יש לבחור תמונת JPEG, PNG או WebP עד 25 מג״ב."); return; }
        working(true); setError(""); setPendingPhoto(file);
      }} /></label>
      {loading && <p role="status">טוען מסמכים…</p>}
      {!loading && !files.length && !error && <p>אין מסמכים מצורפים.</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {files.map((file) => <div key={file.id} className="min-w-0 rounded-xl border border-zinc-200 p-2">
        {isPhoto(file) && <PhotoThumbnail path={file.storage_path} name={file.file_name} disabled={busy} onOpen={() => setViewing(file)} />}
        <button type="button" disabled={busy} className="min-h-11 min-w-0 flex-1 break-words text-right text-blue-700 underline" onClick={async () => {
          if (isPhoto(file)) { setViewing(file); return; }
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
      </div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>}
  </div>;
}
