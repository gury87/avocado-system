"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { roleLabels, type Profile } from "../lib/auth-types";
import Account from "./Account";
import UserManagement from "./UserManagement";

const AuthContext = createContext<{ profile: Profile; refresh: () => Promise<void> } | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Auth provider missing");
  return value;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const [screen, setScreen] = useState<"app" | "account" | "users">("app");
  const generation = useRef(0);
  const currentIdentity = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const mode = params.get("auth");
    const initialTimer = window.setTimeout(() => {
      if (mode === "setup" || mode === "recovery" || hash.get("type") === "recovery" || hash.get("type") === "invite") setSetup(true);
      if (hash.get("error_description")) setError("הקישור אינו תקין או שפג תוקפו. בקש קישור חדש.");
    }, 0);

    const applySession = async (nextSession: Session | null) => {
      const version = ++generation.current;
      if (!alive) return;
      const nextIdentity = nextSession?.user.id || null;
      if (currentIdentity.current !== nextIdentity) {
        currentIdentity.current = nextIdentity;
        setProfile(null);
        setLoading(Boolean(nextSession));
        setScreen("app");
      }
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setLoading(false);
        return;
      }
      try {
        const { data, error: profileError } = await supabase.from("profiles").select("*").eq("id", nextSession.user.id).single();
        if (!alive || version !== generation.current) return;
        if (profileError || !data) {
          setProfile(null);
          setError("לא ניתן לטעון את הרשאות החשבון. פנה למנהל או נסה שוב.");
        } else {
          setProfile(data as Profile);
          setError("");
        }
      } catch {
        if (alive && version === generation.current) {
          setProfile(null);
          setError("לא ניתן לבדוק את הרשאות החשבון. בדוק את החיבור ונסה שוב.");
        }
      } finally {
        if (alive && version === generation.current) setLoading(false);
      }
    };
    // Schedule outside the synchronous Auth callback to avoid locking the Auth client.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "PASSWORD_RECOVERY") setSetup(true);
      if (event === "SIGNED_OUT") {
        ++generation.current;
        setProfile(null);
        setSession(null);
        setScreen("app");
        setSetup(false);
      }
      window.setTimeout(() => { if (alive) void applySession(nextSession); }, 0);
    });
    const checkSession = async () => {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!alive) return;
      if (sessionError) {
        setProfile(null);
        setSession(null);
        setError("לא ניתן לבדוק את ההתחברות. נסה לרענן את העמוד.");
        setLoading(false);
        return;
      }
      await applySession(data.session);
    };
    void checkSession();
    const timer = window.setInterval(() => { void checkSession(); }, 30000);
    const onFocus = () => { void checkSession(); };
    window.addEventListener("focus", onFocus);
    return () => { alive = false; subscription.unsubscribe(); window.clearTimeout(initialTimer); window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);

  const refresh = async () => {
    if (!session) return;
    const identity = session.user.id;
    const { data, error: profileError } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
    if (profileError) throw profileError;
    if (currentIdentity.current !== identity) return;
    setProfile(data as Profile);
  };

  const refreshSafely = () => {
    void refresh().catch(() => {
      setProfile(null);
      setError("לא ניתן לבדוק את הרשאות החשבון. נסה שוב.");
    });
  };

  if (loading) return <AuthFrame><p role="status">בודק התחברות…</p></AuthFrame>;
  if (!session) return <AuthFrame><Login initialError={error} /></AuthFrame>;
  if (!profile || !profile.is_active) return (
    <AuthFrame>
      <p role="alert">{error || "הגישה לחשבון חסומה. פנה למנהל המשק."}</p>
      <button className="mt-4 min-h-11 underline" onClick={() => window.location.reload()}>נסה שוב</button>
      <button className="mr-4 min-h-11 underline" onClick={() => { void supabase.auth.signOut(); }}>יציאה</button>
    </AuthFrame>
  );
  if (setup) return <AuthFrame><Account setup onComplete={() => {
    setSetup(false);
    window.history.replaceState({}, "", "/");
    refreshSafely();
  }} /></AuthFrame>;

  return (
    <AuthContext.Provider value={{ profile, refresh }}>
      <div dir="rtl" className="min-h-screen bg-zinc-100 text-zinc-900">
        <header className="border-b border-zinc-200 bg-white">
          <div className="mx-auto max-w-md space-y-2 px-4 py-3">
            <p className="break-words text-sm">{profile.full_name || profile.email} · {roleLabels[profile.role]}</p>
            <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="חשבון משתמש">
              <button className="min-h-11" onClick={() => setScreen("app")}>המערכת</button>
              <button className="min-h-11" onClick={() => setScreen("account")}>החשבון שלי</button>
              {profile.role === "admin" && <button className="min-h-11" onClick={() => setScreen("users")}>ניהול משתמשים</button>}
              <button className="min-h-11 text-red-700" onClick={async () => {
                const { error: signOutError } = await supabase.auth.signOut();
                if (signOutError) window.alert("היציאה נכשלה. נסה שוב.");
              }}>יציאה</button>
            </nav>
          </div>
        </header>
        {screen === "account" ? <div className="mx-auto max-w-md p-4"><Account onComplete={refreshSafely} /></div>
          : screen === "users" && profile.role === "admin" ? <div className="mx-auto max-w-md p-4"><UserManagement /></div>
            : <div key={`${profile.id}:${profile.role}`}>{children}</div>}
      </div>
    </AuthContext.Provider>
  );
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <main dir="rtl" className="min-h-screen bg-zinc-100 px-4 py-10 text-zinc-900"><div className="mx-auto max-w-md rounded-2xl border border-zinc-200 bg-white p-5"><h1 className="mb-5 text-2xl font-bold">🥑 מערכת ניהול מטעי אבוקדו</h1>{children}</div></main>;
}

function Login({ initialError }: { initialError: string }) {
  const [mode, setMode] = useState<"login" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(initialError);
  return <form className="space-y-4" onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/?auth=recovery` });
        setMessage(error ? "לא ניתן לשלוח קישור כרגע. נסה שוב מאוחר יותר." : "אם האימייל רשום במערכת, יישלח אליו קישור לאיפוס סיסמה.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setMessage("הכניסה נכשלה. בדוק אימייל וסיסמה ונסה שוב.");
      }
    } catch { setMessage("אירעה שגיאת חיבור. נסה שוב."); }
    finally { setBusy(false); }
  }}>
    <h2 className="text-lg font-semibold">{mode === "login" ? "כניסה למערכת" : "שחזור סיסמה"}</h2>
    <label className="block text-sm">אימייל<input required type="email" dir="ltr" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 p-3 text-base" /></label>
    {mode === "login" && <label className="block text-sm">סיסמה<input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 p-3 text-base" /></label>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <button disabled={busy} className="min-h-11 w-full rounded-xl bg-zinc-900 p-3 text-white disabled:opacity-50">{busy ? "נא להמתין…" : mode === "login" ? "כניסה" : "שלח קישור לשחזור"}</button>
    <button type="button" disabled={busy} className="min-h-11 underline" onClick={() => { setMode(mode === "login" ? "reset" : "login"); setMessage(""); }}>{mode === "login" ? "שכחתי סיסמה" : "חזרה לכניסה"}</button>
    <p className="text-xs text-zinc-500">ההצטרפות למערכת בהזמנת מנהל המשק בלבד.</p>
  </form>;
}
