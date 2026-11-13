"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthGate";
import type { BackupOverview, BackupRun } from "../lib/backup-types";

const date = (value: string) => new Date(value).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
function status(run: BackupRun) {
  if (run.status !== "completed") return run.status === "in_progress" ? "בתהליך" : "ממתין";
  return run.conclusion === "success" ? "הצליח" : run.conclusion === "cancelled" ? "בוטל" : "לא הושלם בהצלחה";
}
async function request(method: "GET" | "POST") {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("יש להתחבר מחדש.");
  const response = await fetch("/api/backups", { method, cache: "no-store", headers: { Authorization: `Bearer ${session.access_token}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "הפנייה לשירות הגיבוי נכשלה.");
  return result;
}
export default function BackupManagement() {
  const { profile } = useAuth();
  const [data, setData] = useState<BackupOverview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await request("GET")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "טעינת הגיבויים נכשלה."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (profile.role !== "admin") return;
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [load, profile.role]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => { setPending(false); void load(); }, 60000);
    return () => window.clearTimeout(timer);
  }, [pending, load]);
  if (profile.role !== "admin") return null;
  const last = data?.lastSuccess;
  const stale = !!last && Date.parse(data!.checkedAt) - Date.parse(last.updatedAt) > 48 * 60 * 60 * 1000;
  return <section aria-labelledby="backups-title" className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
    <h3 id="backups-title" className="text-lg font-semibold">גיבויים</h3>
    <p className="text-sm text-zinc-600">הגיבוי היומי כולל את מסד הנתונים, התמונות וקוד האתר ונשמר מוצפן ב־OneDrive.</p>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}{data && " הנתונים המוצגים הם מהבדיקה הקודמת."}</p>}
    {message && <p role="status" className="rounded-lg bg-blue-50 p-3 text-blue-900">{message}</p>}
    {data && <>
      <p className={`rounded-lg p-3 ${stale || !last ? "bg-amber-50 text-amber-900" : "bg-green-50 text-green-900"}`}>
        {last ? `גיבוי מוצלח אחרון: ${date(last.updatedAt)}` : "לא נמצא גיבוי מוצלח."}
        {stale && <span className="block font-semibold">עברו יותר מ־48 שעות מהגיבוי המוצלח האחרון.</span>}
      </p>
      {data.runs[0]?.status === "completed" && data.runs[0].conclusion !== "success" && <p className="text-sm font-semibold text-red-800">הניסיון האחרון לא הושלם בהצלחה. הגיבוי המוצלח הקודם עדיין מופיע למעלה.</p>}
      {!data.canStart && <p role="status" className="text-sm text-amber-900">{data.configurationMessage || "הפעלת גיבוי מהאתר עדיין לא זמינה. נדרשת הגדרת חיבור בשרת הייצור."}</p>}
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={!data?.canStart || !!data.active || starting || pending || !!error || loading} className="min-h-11 rounded-lg bg-zinc-900 px-4 text-white disabled:opacity-50" onClick={async () => {
        if (lock.current) return;
        lock.current = true; setStarting(true); setError(""); setMessage("");
        try {
          const result = await request("POST");
          if (result.accepted) setPending(true);
          setMessage(result.accepted ? "הבקשה לגיבוי התקבלה. הריצה תופיע ברשימה בקרוב; הצלחה תוצג רק לאחר סיום ואימות הגיבוי." : "כבר קיים גיבוי בתהליך או בתור.");
          await load();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "הפעלת הגיבוי נכשלה."); }
        finally { lock.current = false; setStarting(false); }
      }}>{starting ? "שולח בקשה…" : pending ? "ממתין להופעת הריצה…" : data?.active ? "גיבוי בתהליך או בתור" : "גיבוי עכשיו"}</button>
      <button type="button" disabled={loading} className="min-h-11 rounded-lg border px-4 disabled:opacity-50" onClick={() => void load()}>{loading ? "טוען…" : "רענון גיבויים"}</button>
    </div>
    {data && <>
      <p className="text-xs text-zinc-500">נבדק לאחרונה: {date(data.checkedAt)} · השעות לפי שעון ישראל · מתרענן כל 30 שניות</p>
      <ul className="space-y-2">{data.runs.map(run => <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
        <div><p className="font-medium">גיבוי #{run.number} · {run.event === "schedule" ? "יומי" : run.event === "workflow_dispatch" ? "ידני" : "אחר"}{run.attempt > 1 ? ` · ניסיון ${run.attempt}` : ""}</p><p className="text-xs text-zinc-600">{date(run.createdAt)}</p></div>
        <span className={`rounded px-2 py-1 ${run.status !== "completed" ? "bg-blue-50 text-blue-900" : run.conclusion === "success" ? "bg-green-50 text-green-900" : "bg-red-50 text-red-800"}`}>{status(run)}</span>
        <a href={run.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center underline" aria-label={`פרטי גיבוי ${run.number} ב־GitHub`}>פרטי הריצה</a>
      </li>)}</ul>
      {!data.runs.length && <p className="text-sm">עדיין אין ריצות גיבוי להצגה.</p>}
    </>}
  </section>;
}
