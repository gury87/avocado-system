"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { roleLabels, type Profile, type Role } from "../lib/auth-types";
import { useAuth } from "./AuthGate";

async function usersRequest(method: string, body?: object) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("יש להתחבר מחדש.");
  const response = await fetch("/api/users", {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "הפעולה נכשלה.");
  return result;
}

export default function UserManagement() {
  const { profile, refresh } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [search, setSearch] = useState("");
  const [invite, setInvite] = useState({ name: "", email: "", role: "viewer" as Role });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try { const result = await usersRequest("GET"); setUsers(result.users); }
    catch (error) { setMessage(error instanceof Error ? error.message : "טעינת המשתמשים נכשלה."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const perform = async (method: string, body: object, success: string) => {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      await usersRequest(method, body);
      setMessage(success);
      if (method === "POST") setInvite({ name: "", email: "", role: "viewer" });
      await load();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "הפעולה נכשלה.");
      await load();
    } finally { setBusy(false); }
  };
  const visible = users.filter((user) => `${user.full_name} ${user.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const inputClass = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white p-3 text-base";
  return <section className="space-y-4 text-zinc-900">
    <h1 className="text-2xl font-bold">ניהול משתמשים</h1>
    <form className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4" onSubmit={(event) => {
      event.preventDefault();
      void perform("POST", invite, "ההזמנה נשלחה באימייל.");
    }}>
      <h2 className="text-lg font-semibold">הזמנת משתמש</h2>
      <label className="block text-sm">שם מלא<input required maxLength={100} value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} className={inputClass} /></label>
      <label className="block text-sm">אימייל<input required type="email" dir="ltr" maxLength={254} value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} className={inputClass} /></label>
      <label className="block text-sm">תפקיד<select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })} className={inputClass}>
        {(Object.entries(roleLabels) as [Role, string][]).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
      </select></label>
      <button disabled={busy} className="min-h-11 w-full rounded-xl bg-zinc-900 p-3 text-white disabled:opacity-50">{busy ? "נא להמתין…" : "שליחת הזמנה"}</button>
    </form>
    {message && <p role="status" className="rounded-lg bg-white p-3 text-sm">{message}</p>}
    <label className="block text-sm">חיפוש משתמשים<input type="search" placeholder="שם או אימייל" value={search} onChange={(e) => setSearch(e.target.value)} className={inputClass} /></label>
    <button type="button" disabled={busy} onClick={() => { void load(); }} className="min-h-11 underline">רענון רשימה</button>
    {loading && <p role="status">טוען משתמשים…</p>}
    {!loading && visible.length === 0 && <p>לא נמצאו משתמשים.</p>}
    <div className="space-y-3">
      {visible.map((user) => <article key={user.id} className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4">
        <div>
          <h2 className="break-words font-semibold">{user.full_name || "ללא שם"}{user.id === profile.id ? " (אני)" : ""}</h2>
          <p dir="ltr" className="break-all text-right text-sm text-zinc-600">{user.email}</p>
          <p className="mt-1 text-sm">{!user.is_active ? "חסום" : user.joined_at ? "פעיל" : "מוזמן — טרם השלים הגדרה"}</p>
        </div>
        <label className="block text-sm">תפקיד
          <select disabled={busy} value={user.role} className={inputClass} onChange={(event) => {
            const role = event.target.value as Role;
            if (window.confirm(`לשנות את התפקיד של ${user.full_name || user.email} ל${roleLabels[role]}?`)) {
              void perform("PATCH", { id: user.id, role, is_active: user.is_active }, "התפקיד עודכן.");
            }
          }}>
            {(Object.entries(roleLabels) as [Role, string][]).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-zinc-300 px-3 text-sm disabled:opacity-50" onClick={() => {
            if (window.confirm(`${user.is_active ? "לחסום את הגישה של" : "להפעיל את החשבון של"} ${user.full_name || user.email}?`)) {
              void perform("PATCH", { id: user.id, role: user.role, is_active: !user.is_active }, user.is_active ? "הגישה נחסמה." : "הגישה הופעלה.");
            }
          }}>{user.is_active ? "חסימת גישה" : "הפעלת חשבון"}</button>
          {!user.joined_at && user.is_active && <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-zinc-300 px-3 text-sm disabled:opacity-50"
            onClick={() => { void perform("POST", { name: user.full_name, email: user.email, role: user.role, resend: true }, "ההזמנה נשלחה שוב."); }}>שליחת הזמנה מחדש</button>}
        </div>
      </article>)}
    </div>
  </section>;
}
