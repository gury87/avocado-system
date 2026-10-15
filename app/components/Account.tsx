"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Account({ setup = false, onComplete }: { setup?: boolean; onComplete?: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) throw new Error("USER_UNAVAILABLE");
        const { data: profile, error: profileError } = await supabase.from("profiles").select("full_name").eq("id", data.user.id).single();
        if (profileError || !profile) throw new Error("PROFILE_UNAVAILABLE");
        if (alive) { setEmail(data.user.email || ""); setName(profile.full_name || ""); setReady(true); }
      } catch {
        if (alive) setMessage("לא ניתן לטעון את פרטי החשבון. נסה לרענן או להתחבר מחדש.");
      }
    };
    void load();
    return () => { alive = false; };
  }, []);
  const inputClass = "mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-white p-3 text-base";
  return <form className="space-y-4 rounded-2xl bg-white p-4 text-zinc-900" onSubmit={async (event) => {
    event.preventDefault();
    if (busy || !ready) return;
    if (password && (password.length < 12 || password !== confirmation)) { setMessage("יש להזין סיסמה של לפחות 12 תווים ולוודא שהסיסמאות זהות."); return; }
    setBusy(true); setMessage("");
    try {
      if (password) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) { setMessage("שינוי הסיסמה נכשל. נסה סיסמה אחרת או קישור שחזור חדש."); return; }
      }
      const { error: nameError } = await supabase.rpc("update_my_profile", { new_name: name.trim() });
      if (nameError) { setMessage(password ? "הסיסמה עודכנה אך שמירת השם נכשלה. נסה שוב או פנה למנהל." : "עדכון הפרטים נכשל. פנה למנהל המשק."); return; }
      setPassword(""); setConfirmation(""); setMessage("הפרטים נשמרו בהצלחה.");
      onComplete?.();
    } catch { setMessage("אירעה שגיאת חיבור. נסה שוב."); }
    finally { setBusy(false); }
  }}>
    <h2 className="text-xl font-semibold">{setup ? "הגדרת החשבון והסיסמה" : "החשבון שלי"}</h2>
    <p className="break-all text-sm text-zinc-600" dir="ltr">{email}</p>
    <label className="block text-sm">שם מלא<input required maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></label>
    <label className="block text-sm">{setup ? "סיסמה" : "סיסמה חדשה (רשות)"}<input type="password" required={setup} minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} /></label>
    <p className="text-xs text-zinc-500">לפחות 12 תווים.</p>
    <label className="block text-sm">אימות סיסמה<input type="password" required={setup || Boolean(password)} autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className={inputClass} /></label>
    {message && <p role="status" className="text-sm">{message}</p>}
    <button disabled={busy || !ready} className="min-h-11 w-full rounded-xl bg-zinc-900 p-3 text-white disabled:opacity-50">{busy ? "שומר…" : "שמירת פרטים"}</button>
    {setup && <button type="button" className="min-h-11 underline" onClick={() => { void supabase.auth.signOut(); }}>יציאה</button>}
  </form>;
}
