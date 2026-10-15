import { apiError, requireAdmin, serviceClient } from "@/app/lib/admin-server";

export async function GET(request: Request) {
  try {
    const { client } = await requireAdmin(request);
    const { data, error } = await client.from("profiles").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return Response.json({ users: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const { client, user } = await requireAdmin(request);
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name || name.length > 100 ||
      !["admin", "worker", "viewer"].includes(body.role)) {
      return Response.json({ error: "יש להזין שם, אימייל ותפקיד תקינים." }, { status: 400 });
    }
    const siteUrl = process.env.APP_URL;
    if (!siteUrl || !/^https?:\/\//.test(siteUrl)) throw new Error("SERVER_CONFIG");
    const { data: existing, error: lookupError } = await client.from("profiles").select("id,joined_at,is_active,role")
      .eq("email", email).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing && (existing.joined_at || !existing.is_active || !body.resend)) {
      return Response.json({ error: "המשתמש כבר קיים. ניתן לשנות את הרשאותיו ברשימה." }, { status: 409 });
    }
    const { data, error } = await serviceClient().auth.admin.inviteUserByEmail(email, {
      redirectTo: `${siteUrl.replace(/\/$/, "")}/?auth=setup`, data: { full_name: name },
    });
    if (error || !data.user) {
      console.error("Invite failed", error?.code);
      return Response.json({ error: "שליחת ההזמנה נכשלה. ייתכן שהאימייל כבר רשום או שמגבלת שליחת האימיילים נוצלה." }, { status: 400 });
    }
    if (!existing) {
      const { error: assignError } = await client.rpc("admin_set_profile", {
        target_id: data.user.id, new_role: body.role, new_active: true, new_name: name,
      });
      if (assignError) {
        console.error("Invite role assignment failed", assignError);
        return Response.json({ error: "ההזמנה נשלחה אך הגישה עדיין חסומה. הפעל את המשתמש והגדר את תפקידו ברשימה." }, { status: 409 });
      }
      // invited_by is set inside the database RPC using the verified caller identity.
    }
    return Response.json({ ok: true, invitedBy: user.id });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { client } = await requireAdmin(request);
    const body = await request.json();
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id) ||
      !["admin", "worker", "viewer"].includes(body.role) || typeof body.is_active !== "boolean") {
      return Response.json({ error: "פרטי המשתמש אינם תקינים." }, { status: 400 });
    }
    const { error } = await client.rpc("admin_set_profile", {
      target_id: body.id, new_role: body.role, new_active: body.is_active, new_name: null,
    });
    if (error) return Response.json({ error: error.message.includes("LAST_ADMIN")
      ? "לא ניתן לחסום את המנהל הפעיל האחרון או לשנות את תפקידו."
      : "עדכון המשתמש נכשל. בדוק הרשאות ונסה שוב." }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
