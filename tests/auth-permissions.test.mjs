import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  worker: "00000000-0000-4000-8000-000000000002",
  viewer: "00000000-0000-4000-8000-000000000003",
  stranger: "00000000-0000-4000-8000-000000000004",
};
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Farm permissions and audit are enforced by PostgreSQL", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      grant usage on schema auth to anon, authenticated;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      create table public.harvest_events (
        id bigserial primary key, harvest_date date, containers int, container_size text
      );
      create table public.payments (id int primary key);
      insert into public.payments values (1);
      insert into public.harvest_events (harvest_date, containers, container_size)
        values ('2026-10-01', 5, 'קטן');
      alter table public.harvest_events enable row level security;
      create policy old_public_access on public.harvest_events for all using (true) with check (true);
      grant all on public.harvest_events, public.payments to anon, authenticated;
      alter table public.payments enable row level security;
      create policy old_payment_access on public.payments for select using (true);
    `);
    await db.exec(await read("supabase/migrations/001_users.sql"));
    for (const [role, id] of Object.entries(ids)) {
      await db.query("insert into auth.users values ($1, $2, $3)", [id,
        role === "admin" ? "gury87@gmail.com" : `${role}@example.com`,
        { full_name: role, role: "admin", is_active: true }]);
    }
    assert.equal((await db.query("select count(*)::int as n from profiles where is_active")).rows[0].n, 0,
      "Untrusted Auth metadata cannot grant access or administrator privileges");
    await db.exec(await read("supabase/bootstrap-admin.sql"));

    async function asUser(id, query, params = [], role = "authenticated") {
      await db.exec(`begin; set local role ${role};`);
      try {
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id || ""]);
        const result = await db.query(query, params);
        await db.exec("commit");
        return result.rows;
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    }
    await asUser(ids.admin, "select admin_set_profile($1, 'worker', true, 'עובד')", [ids.worker]);
    await asUser(ids.admin, "select admin_set_profile($1, 'viewer', true, 'צופה')", [ids.viewer]);
    await db.exec(await read("supabase/migrations/002_secure_farm.sql"));

    await t.test("Anonymous access and old public policies are closed", async () => {
      await assert.rejects(asUser(null, "select * from harvest_events", [], "anon"));
      assert.equal((await asUser(null, "select * from payments", [], "anon")).length, 0);
      assert.equal((await asUser(ids.stranger, "select * from harvest_events")).length, 0);
      assert.equal((await asUser(ids.stranger, "select * from payments")).length, 0);
      const old = await db.query("select * from pg_policies where policyname = 'old_public_access'");
      assert.equal(old.rows.length, 0);
    });
    await t.test("Roles can read, but only workers/admins insert and only admins delete", async () => {
      for (const role of ["admin", "worker", "viewer"]) {
        assert.equal((await asUser(ids[role], "select * from harvest_events")).length, 1);
      }
      await assert.rejects(asUser(ids.viewer, "insert into harvest_events (containers) values (3)"));
      await assert.rejects(asUser(ids.stranger, "insert into harvest_events (containers) values (3)"));
      const created = await asUser(ids.worker,
        "insert into harvest_events (harvest_date, containers, container_size, created_by) values ('2026-10-15', 3, 'קטן', $1) returning *", [ids.admin]);
      assert.equal(created[0].created_by, ids.worker, "Caller cannot forge the record creator");
      const id = created[0].id;
      for (const role of ["worker", "viewer"]) {
        assert.equal((await asUser(ids[role], "delete from harvest_events where id = $1 returning id", [id])).length, 0);
      }
      assert.equal((await asUser(ids.admin, "delete from harvest_events where id = $1 returning id", [id])).length, 1);
      const audit = await asUser(ids.admin, "select * from audit_log where action = 'shipment_deleted'");
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_id, ids.admin);
      assert.equal(audit[0].details.containers, 3);
      assert.equal((await asUser(ids.worker, "select * from audit_log")).length, 0);
      await assert.rejects(asUser(ids.admin, "delete from audit_log"));
    });
    await t.test("Profiles cannot be used to elevate permissions", async () => {
      assert.equal((await asUser(ids.worker, "select * from profiles")).length, 1);
      await assert.rejects(asUser(ids.worker, "update profiles set role = 'admin' where id = $1", [ids.worker]));
      await assert.rejects(asUser(ids.worker, "select admin_set_profile($1, 'admin', true, null)", [ids.worker]));
      await asUser(ids.worker, "select update_my_profile('שם חדש')");
      assert.equal((await asUser(ids.worker, "select full_name from profiles"))[0].full_name, "שם חדש");
    });
    await t.test("Blocking affects requests with an existing user identity immediately", async () => {
      await asUser(ids.admin, "select admin_set_profile($1, 'worker', false, null)", [ids.worker]);
      assert.equal((await asUser(ids.worker, "select * from harvest_events")).length, 0);
      await assert.rejects(asUser(ids.worker, "insert into harvest_events (containers) values (1)"));
      await assert.rejects(asUser(ids.worker, "select update_my_profile('blocked')"));
      await asUser(ids.admin, "select admin_set_profile($1, 'worker', true, null)", [ids.worker]);
      assert.equal((await asUser(ids.worker, "select * from harvest_events")).length, 1);
    });
    await t.test("The last active admin cannot be blocked or demoted", async () => {
      await assert.rejects(asUser(ids.admin, "select admin_set_profile($1, 'admin', false, null)", [ids.admin]), /LAST_ADMIN/);
      await assert.rejects(asUser(ids.admin, "select admin_set_profile($1, 'viewer', true, null)", [ids.admin]), /LAST_ADMIN/);
      await asUser(ids.admin, "select admin_set_profile($1, 'admin', true, null)", [ids.worker]);
      await asUser(ids.worker, "select admin_set_profile($1, 'viewer', true, null)", [ids.admin]);
      await assert.rejects(asUser(ids.worker, "select admin_set_profile($1, 'viewer', true, null)", [ids.worker]), /LAST_ADMIN/);
      await assert.rejects(asUser(ids.admin, "select admin_set_profile($1, 'admin', true, null)", [ids.admin]), /FORBIDDEN/);
    });
  } finally { await db.close(); }
});
