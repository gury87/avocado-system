"use client";
/* eslint-disable @next/next/no-img-element -- Private signed image; preserve native dimensions for zoom. */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import PhotoDialog from "./PhotoDialog";
import { clamp } from "../lib/photos";

export function usePrivatePhoto(path: string) {
  const [url, setUrl] = useState(""), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const { data, error } = await supabase.storage.from("farm-documents").createSignedUrl(path, 300);
        if (active) { setError(Boolean(error || !data)); if (data) setUrl(data.signedUrl); }
      } catch { if (active) setError(true); }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 240000);
    return () => { active = false; window.clearInterval(timer); };
  }, [path, retry]);
  return { url, error, failed: () => setError(true), reload: () => { setError(false); setUrl(""); setRetry((value) => value + 1); } };
}
export function PhotoThumbnail({ path, name, disabled, onOpen }: { path: string; name: string; disabled: boolean; onOpen: () => void }) {
  const photo = usePrivatePhoto(path);
  return <div className="min-w-0">
    <button type="button" disabled={disabled} aria-label={`הגדל תמונה ${name}`} onClick={onOpen} className="flex h-28 w-full items-center justify-center overflow-hidden rounded-lg bg-zinc-100 disabled:opacity-50">
      {photo.url && !photo.error ? <img loading="lazy" draggable={false} alt={name} src={photo.url} onError={photo.failed} className="h-full w-full object-contain" /> : <span className="p-2 text-xs text-zinc-600">{photo.error ? "התצוגה לא נטענה" : "טוען תמונה…"}</span>}
    </button>
    {photo.error && <button type="button" disabled={disabled} onClick={photo.reload} className="min-h-11 text-xs underline">נסה לטעון שוב</button>}
  </div>;
}
type View = { scale: number; x: number; y: number };
const initial: View = { scale: 1, x: 0, y: 0 };
export default function PhotoViewer({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const photo = usePrivatePhoto(path), stage = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(initial), [loaded, setLoaded] = useState(false);
  const current = useRef<View>(initial), pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; points: { x: number; y: number }[] } | null>(null);
  const update = useCallback((next: View) => {
    const container = stage.current, img = image.current; if (!container || !img) return;
    const scale = clamp(next.scale, 1, 6);
    const maxX = Math.max(0, (img.offsetWidth * scale - container.clientWidth) / 2), maxY = Math.max(0, (img.offsetHeight * scale - container.clientHeight) / 2);
    current.current = { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) }; setView(current.current);
  }, []);
  const zoom = useCallback((scale: number, x = 0, y = 0) => {
    const old = current.current, next = clamp(scale, 1, 6), ratio = next / old.scale;
    update({ scale: next, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio });
  }, [update]);
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); const rect = element.getBoundingClientRect();
      zoom(current.current.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    };
    const resize = () => update(current.current);
    element.addEventListener("wheel", wheel, { passive: false }); window.addEventListener("resize", resize);
    return () => { element.removeEventListener("wheel", wheel); window.removeEventListener("resize", resize); };
  }, [zoom, update]);
  const resetGesture = () => { gesture.current = { view: { ...current.current }, points: [...pointers.current.values()] }; };
  return <PhotoDialog title={name} onClose={onClose}>
    <div ref={stage} data-photo-viewer className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden" dir="ltr"
      onDoubleClick={() => zoom(current.current.scale > 1 ? 1 : 2)}
      onPointerDown={(event) => {
        if (event.button !== 0 || !loaded) return;
        event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); resetGesture();
      }} onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId) || !gesture.current) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = [...pointers.current.values()], start = gesture.current;
        if (points.length >= 2 && start.points.length >= 2) {
          const distance = (p: { x: number; y: number }[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
          const base = distance(start.points); if (base < 1) return;
          const scale = clamp(start.view.scale * distance(points) / base, 1, 6), ratio = scale / start.view.scale;
          const rect = event.currentTarget.getBoundingClientRect();
          const oldX = (start.points[0].x + start.points[1].x) / 2 - rect.left - rect.width / 2, oldY = (start.points[0].y + start.points[1].y) / 2 - rect.top - rect.height / 2;
          const newX = (points[0].x + points[1].x) / 2 - rect.left - rect.width / 2, newY = (points[0].y + points[1].y) / 2 - rect.top - rect.height / 2;
          update({ scale, x: newX - (oldX - start.view.x) * ratio, y: newY - (oldY - start.view.y) * ratio });
        } else if (points.length === 1 && start.points.length === 1) update({ scale: start.view.scale, x: start.view.x + points[0].x - start.points[0].x, y: start.view.y + points[0].y - start.points[0].y });
      }} onPointerUp={(event) => { pointers.current.delete(event.pointerId); resetGesture(); }} onPointerCancel={(event) => { pointers.current.delete(event.pointerId); resetGesture(); }}>
      {photo.url && !photo.error && <img ref={image} alt={name} draggable={false} src={photo.url} onLoad={() => { setLoaded(true); update(current.current); }} onError={photo.failed}
        style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, cursor: view.scale > 1 ? "grab" : "zoom-in" }} />}
      {(!photo.url || photo.error) && <div className="p-4 text-center"><p role={photo.error ? "alert" : "status"}>{photo.error ? "לא ניתן לטעון את התמונה." : "טוען תמונה…"}</p>{photo.error && <button type="button" onClick={photo.reload} className="mt-3 min-h-11 rounded-lg border px-3">נסה שוב</button>}</div>}
    </div>
    <footer className="shrink-0 border-t border-white/20 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center">
      <div className="flex items-center justify-center gap-3" dir="ltr">
        <button type="button" aria-label="הקטן תמונה" disabled={!loaded || view.scale <= 1} onClick={() => zoom(view.scale / 1.5)} className="min-h-11 min-w-11 rounded-lg border disabled:opacity-40">−</button>
        <output aria-label="רמת הגדלה">{Math.round(view.scale * 100)}%</output>
        <button type="button" aria-label="הגדל תמונה" disabled={!loaded || view.scale >= 6} onClick={() => zoom(view.scale * 1.5)} className="min-h-11 min-w-11 rounded-lg border disabled:opacity-40">+</button>
        <button type="button" onClick={() => update(initial)} className="min-h-11 rounded-lg border px-3">התאם למסך</button>
      </div>
      <p className="mt-2 text-xs text-zinc-300">צביטה בשתי אצבעות להגדלה · גרירה להזזה · לחיצה כפולה להגדלה ואיפוס</p>
    </footer>
  </PhotoDialog>;
}
