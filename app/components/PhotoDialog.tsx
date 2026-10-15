"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
export default function PhotoDialog({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const root = document.documentElement, previous = root.style.overflow;
    root.style.overflow = "hidden"; dialog.current?.showModal();
    return () => { root.style.overflow = previous; };
  }, []);
  return createPortal(<dialog ref={dialog} dir="rtl" aria-label={title} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    style={{ width: "100vw", height: "100dvh", maxWidth: "none", maxHeight: "none", right: 0, left: "auto", top: 0, margin: 0 }}
    className="fixed border-0 bg-zinc-950 p-0 text-white backdrop:bg-black/80">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/20 px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <h2 className="min-w-0 truncate font-semibold">{title}</h2>
        <button autoFocus type="button" disabled={busy} onClick={onClose} aria-label="סגור תמונה" className="min-h-11 shrink-0 rounded-lg border border-white/40 px-4 disabled:opacity-50">סגירה</button>
      </header>
      {children}
    </div>
  </dialog>, document.body);
}
