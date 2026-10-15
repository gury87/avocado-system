import "server-only";
import { createClient } from "@supabase/supabase-js";

export async function requireAdmin(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new Error("UNAUTHORIZED");
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) throw new Error("UNAUTHORIZED");
  const { data: profile, error: profileError } = await client.from("profiles")
    .select("role,is_active").eq("id", user.id).single();
  if (profileError || profile?.role !== "admin" || !profile.is_active) throw new Error("FORBIDDEN");
  return { client, user };
}

export function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SERVER_CONFIG");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function apiError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "UNAUTHORIZED") return Response.json({ error: "יש להתחבר מחדש." }, { status: 401 });
  if (code === "FORBIDDEN") return Response.json({ error: "הפעולה מותרת למנהל פעיל בלבד." }, { status: 403 });
  console.error("User management request failed", error);
  return Response.json({ error: "הפעולה נכשלה. בדוק את הגדרות השירות ונסה שוב." }, { status: 500 });
}
