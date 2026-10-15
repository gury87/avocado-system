"use client";
/* eslint-disable @next/next/no-img-element -- Local canvas preview; no remote image optimization. */
import { useEffect, useMemo, useRef, useState } from "react";
import PhotoDialog from "./PhotoDialog";
import { clamp, decodePhoto, exportPhoto, fullCrop, moveCrop, rotatePhoto, type Crop } from "../lib/photos";

export default function PhotoEditor({ file, onCancel, onSave }: { file: File; onCancel: () => void; onSave: (file: File) => Promise<boolean> }) {
  const [source, setSource] = useState<HTMLCanvasElement | null>(null), [turns, setTurns] = useState(0), [crop, setCrop] = useState<Crop>(fullCrop);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; crop: Crop; handle: string } | null>(null);
  useEffect(() => {
    let active = true;
    void decodePhoto(file).then((canvas) => { if (active) setSource(canvas); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "לא ניתן לפתוח את התמונה. בחר JPEG, PNG או WebP."); });
    return () => { active = false; };
  }, [file]);
  const preview = useMemo(() => {
    if (!source) return null;
    const canvas = rotatePhoto(source, turns); return { canvas, url: canvas.toDataURL("image/png") };
  }, [source, turns]);
  return <PhotoDialog title="עריכת תמונה לפני העלאה" busy={busy} onClose={onCancel}>
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-center">
      <p className="mb-3 text-sm">גרור את פינות המסגרת לחיתוך, או את האזור המסומן להזזה.</p>
      {!preview && !error && <p role="status">טוען תמונה…</p>}
      {preview && <div dir="ltr" data-photo-crop className="relative mx-auto inline-block touch-none overflow-hidden align-top" style={{ maxWidth: "100%" }}
        onPointerDown={(event) => {
          if (busy || event.button !== 0) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle || "move";
          drag.current = { x: event.clientX, y: event.clientY, crop, handle };
        }}
        onPointerMove={(event) => {
          if (!drag.current || busy) return;
          const rect = event.currentTarget.getBoundingClientRect(), start = drag.current;
          setCrop(moveCrop(start.crop, (event.clientX - start.x) / rect.width, (event.clientY - start.y) / rect.height, start.handle));
        }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <img alt="תמונה לחיתוך" draggable={false} src={preview.url} style={{ maxWidth: "100%", maxHeight: "48dvh", width: "auto", height: "auto", display: "block" }} />
        <div data-handle="move" data-crop-box style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`, boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)" }} className="absolute cursor-move border-2 border-green-400">
          {(["nw", "ne", "sw", "se"] as const).map((handle) => <span key={handle} data-handle={handle} aria-hidden="true" className="absolute h-7 w-7 border-2 border-white bg-green-700/80" style={{ [handle.includes("n") ? "top" : "bottom"]: 0, [handle.includes("w") ? "left" : "right"]: 0 }} />)}
        </div>
      </div>}
      {preview && <>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button type="button" disabled={busy} onClick={() => { setTurns(turns + 1); setCrop(fullCrop); }} className="min-h-11 rounded-lg border border-white/40 px-3">סיבוב 90°</button>
          <button type="button" disabled={busy} onClick={() => setCrop(fullCrop)} className="min-h-11 rounded-lg border border-white/40 px-3">בטל חיתוך</button>
          <button type="button" disabled={busy} onClick={() => { setTurns(0); setCrop(fullCrop); }} className="min-h-11 rounded-lg border border-white/40 px-3">איפוס תמונה</button>
        </div>
        <details className="mx-auto mt-3 max-w-md text-right text-sm"><summary className="min-h-11 cursor-pointer">דיוק החיתוך</summary>
          {([{ key: "x", label: "גבול שמאל" }, { key: "y", label: "גבול עליון" }, { key: "width", label: "רוחב" }, { key: "height", label: "גובה" }] as const).map(({ key, label }) => <label key={key} className="block py-1">{label}<input disabled={busy} dir="ltr" type="range" min={key === "width" || key === "height" ? 3 : 0} max={100} value={Math.round(crop[key] * 100)} className="block min-h-11 w-full" onChange={(event) => {
            const value = Number(event.target.value) / 100;
            setCrop((c) => key === "x" ? { ...c, x: clamp(value, 0, 1 - c.width) } : key === "y" ? { ...c, y: clamp(value, 0, 1 - c.height) } : key === "width" ? { ...c, width: clamp(value, 0.03, 1 - c.x) } : { ...c, height: clamp(value, 0.03, 1 - c.y) });
          }} /></label>)}
        </details>
      </>}
      {error && <p role="alert" className="mt-3 text-red-300">{error}</p>}
    </div>
    <footer className="shrink-0 border-t border-white/20 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <button type="button" disabled={busy || !preview} className="min-h-11 w-full rounded-xl bg-green-700 p-3 font-semibold disabled:opacity-50" onClick={async () => {
        if (!preview || busy) return;
        setBusy(true); setError("");
        try { const output = await exportPhoto(preview.canvas, crop, file.name); if (!await onSave(output)) setError("ההעלאה נכשלה. אפשר לנסות שוב או לסגור."); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "לא ניתן לשמור את התמונה."); }
        finally { setBusy(false); }
      }}>{busy ? "שומר ומעלה…" : "שמירה והעלאה"}</button>
    </footer>
  </PhotoDialog>;
}
