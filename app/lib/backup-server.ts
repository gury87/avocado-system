import "server-only";
import type { BackupOverview, BackupRun } from "./backup-types";

const base = "https://api.github.com/repos/gury87/avocado-system/actions/workflows/backup.yml";
const active = (run: BackupRun) => run.status !== "completed";
export function backupCanStart() {
  const ref = process.env.BACKUP_SITE_PROJECT_REF;
  return process.env.VERCEL_ENV === "production" && !!process.env.BACKUP_GITHUB_TOKEN &&
    !!ref && /^[a-z0-9]+$/.test(ref) && process.env.NEXT_PUBLIC_SUPABASE_URL === `https://${ref}.supabase.co`;
}
async function github(path: string, method = "GET") {
  const token = process.env.VERCEL_ENV === "production" ? process.env.BACKUP_GITHUB_TOKEN : undefined;
  let response: Response;
  try {
    response = await fetch(base + path, {
      method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify({ ref: "main", inputs: { reason: "manual" } }) } : {}),
    });
  } catch { throw new Error(method === "POST" ? "DISPATCH_UNKNOWN" : "GITHUB_UNAVAILABLE"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? "GITHUB_ACCESS" : "GITHUB_UNAVAILABLE");
  }
  if (method === "POST") { await response.body?.cancel(); return null; }
  return response.json();
}
function run(raw: Record<string, unknown>): BackupRun {
  const id = Number(raw.id);
  return { id, number: Number(raw.run_number), attempt: Number(raw.run_attempt || 1),
    status: String(raw.status), conclusion: raw.conclusion == null ? null : String(raw.conclusion),
    createdAt: String(raw.run_started_at || raw.created_at), updatedAt: String(raw.updated_at), event: String(raw.event),
    url: `https://github.com/gury87/avocado-system/actions/runs/${id}` };
}
export async function backupOverview(): Promise<BackupOverview> {
  const [recent, success] = await Promise.all([
    github("/runs?branch=main&per_page=100"), github("/runs?branch=main&status=success&per_page=1"),
  ]);
  const runs: BackupRun[] = recent.workflow_runs.map(run);
  return { runs: runs.slice(0, 10), lastSuccess: success.workflow_runs[0] ? run(success.workflow_runs[0]) : null,
    canStart: backupCanStart(), active: runs.some(active), checkedAt: new Date().toISOString() };
}
export async function startBackup() {
  if (!backupCanStart()) throw new Error("BACKUP_CONFIG");
  const overview = await backupOverview();
  if (overview.active) return { accepted: false, alreadyRunning: true };
  await github("/dispatches", "POST");
  return { accepted: true, alreadyRunning: false };
}
export function backupError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const errors: Record<string, [number, string]> = {
    UNAUTHORIZED: [401, "יש להתחבר מחדש."], FORBIDDEN: [403, "הפעולה מותרת למנהל פעיל בלבד."],
    BACKUP_CONFIG: [503, "הפעלת גיבוי מהאתר עדיין לא הוגדרה בסביבת הייצור."],
    GITHUB_ACCESS: [503, "אין גישה לשירות הגיבוי. יש לבדוק את הרשאת מפתח השרת ותוקפו."],
    DISPATCH_UNKNOWN: [502, "לא התקבל אישור משירות הגיבוי. ייתכן שהבקשה התקבלה; רענן את הרשימה לפני ניסיון נוסף."],
  };
  const [status, message] = errors[code] || [502, "לא ניתן לקבל מידע משירות הגיבוי כרגע. נסה לרענן בעוד מספר דקות."];
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
