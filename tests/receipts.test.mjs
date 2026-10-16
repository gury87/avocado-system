import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { calculatedAmount, cents, matchCandidates, availableContainers, normalizeWorkspace, receiptValidation } from "../app/lib/receipts.ts";

const admin = "00000000-0000-4000-8000-000000000001";
const worker = "00000000-0000-4000-8000-000000000002";
const viewer = "00000000-0000-4000-8000-000000000003";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function line({ shipment = "1", containers = "1", net = "100", variety = "2", price = "3", amount = calculatedAmount(net, price), allocations } = {}) {
  return { id: randomUUID(), trader_date: "2026-09-07", variety_id: variety, gross_weight: String(Number(net) + Number(containers) * 40),
    containers, tare_weight: "40", net_weight: net, price_per_kg: price, amount,
    allocations: allocations || [{ harvest_event_id: shipment, containers, net_weight: net }] };
}
function receipt(lines = [line()], amount = String(lines.reduce((sum, item) => sum + cents(item.amount), 0) / 100)) {
  return { id: randomUUID(), version: 0, status: "draft", trader_id: "1", payment_date: "2026-09-18", received_date: "2026-09-15",
    method: "cheque", amount, reference: "123", notes: "", adjustment_reason: "", lines };
}

test("Money calculations and matching use explicit amounts and shipment dates", () => {
  assert.equal(calculatedAmount("387", "3.5"), "1354.50");
  assert.equal(calculatedAmount("1.005", "1"), "1.01");
  assert.equal(calculatedAmount("560", "1.8"), "1008.00");
  assert.equal(calculatedAmount("", "3.5"), "");
  const draft = receipt([line({ containers: "2", net: "560" })]);
  const shipments = [
    { id: "1", trader_id: "1", variety_id: "2", plot_id: "1", harvest_date: "2026-09-06", containers: 2, used_containers: 0 },
    { id: "2", trader_id: "1", variety_id: "2", plot_id: "2", harvest_date: "2026-09-07", containers: 4, used_containers: 0 },
    { id: "3", trader_id: "2", variety_id: "2", plot_id: "1", harvest_date: "2026-09-07", containers: 2, used_containers: 0 },
  ];
  const suggestions = matchCandidates(shipments, draft, draft.lines[0]);
  assert.equal(suggestions[0].id, "1");
  assert.equal(suggestions[0].days, 1);
  assert.equal(suggestions.length, 2, "Other traders are excluded");
  assert.equal(draft.lines[0].allocations.length, 1, "Suggestions do not change assignments");
  const usedShipment = { ...shipments[0], used_containers: 2 };
  assert.equal(availableContainers(usedShipment, draft, { ...draft, status: "confirmed" }, draft.lines[0].id), 2, "An edited receipt gets its own capacity back");
  assert.equal(receiptValidation(draft), null);
  assert.match(receiptValidation({ ...draft, amount: "999" }), /הפרש/);
});

test("Receipt SQL enforces atomic accounting, permissions and allocation limits", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; grant usage on schema auth to anon, authenticated;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      create table public.traders (id bigint primary key, name text);
      insert into traders values (1, 'ראובן יהודה'), (2, 'סוחר אחר');
      create table public.plots(id bigint generated always as identity primary key, plot_name text not null, dunam numeric);
      insert into plots(plot_name,dunam) values ('כביש 70',10),('חלקה א',20),('בית העלמין',null);
      create table public.varieties(id bigint generated always as identity primary key, variety_name text not null);
      insert into varieties(variety_name) values ('אטינגר'),('גליל'),('הס'),('פוארטה');
      create table public.harvest_events (
        id bigserial primary key, trader_id bigint references traders(id), harvest_date date,
        variety_id bigint, plot_id bigint, containers numeric, container_size text, picking_cost numeric
      );
      insert into harvest_events (trader_id, harvest_date, variety_id, plot_id, containers, container_size) values
        (1, '2026-09-06', 2, 1, 4, 'קטן'), (1, '2026-09-08', 1, 2, 1, 'קטן'),
        (1, '2026-09-09', 1, 3, 1, 'קטן'), (1, '2026-09-06', 2, 2, 1, 'קטן'),
        (2, '2026-09-06', 2, 1, 5, 'קטן');
    `);
    await db.exec(await read("supabase/migrations/001_users.sql"));
    for (const [id, email] of [[admin, "gury87@gmail.com"], [worker, "worker@example.com"], [viewer, "viewer@example.com"]]) {
      await db.query("insert into auth.users values ($1,$2,'{}')", [id, email]);
    }
    await db.exec(await read("supabase/bootstrap-admin.sql"));
    await db.query("update profiles set role = 'worker', is_active = true where id = $1", [worker]);
    await db.query("update profiles set role = 'viewer', is_active = true where id = $1", [viewer]);
    await db.exec(await read("supabase/migrations/002_secure_farm.sql"));
    await db.exec(await read("supabase/migrations/003_receipts.sql"));
    await db.exec(await read("supabase/migrations/004_edit_shipments.sql"));
    await db.exec(await read("supabase/migrations/005_delete_receipts.sql"));
    // Supabase Storage provides these tables/roles in production.
    await db.exec(`create schema storage; grant usage on schema storage to anon, authenticated;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
      alter table storage.objects enable row level security;
      grant select, insert, delete on storage.objects to authenticated;`);
    await db.exec(await read("supabase/migrations/006_reports_documents.sql"));
    await db.exec(await read("supabase/migrations/007_edit_shipment_trader.sql"));
    await db.exec(await read("supabase/migrations/008_settings_catalogs.sql"));
    const asUser = async (user, query, params = [], role = "authenticated") => {
      await db.exec(`begin; set local role ${role};`);
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user || ""]);
        const result = await db.query(query, params);
        await db.exec("commit"); return result.rows;
      } catch (error) { await db.exec("rollback"); throw error; }
    };
    const save = async (item, finalize = true, user = admin) =>
      (await asUser(user, "select save_farm_receipt($1::jsonb,$2) as receipt", [JSON.stringify(item), finalize]))[0].receipt;
    const weights = async (user = admin) => await asUser(user, "select * from get_paid_shipment_weights()");
    const workspace = async () => normalizeWorkspace((await asUser(admin, "select get_receipt_workspace() as data"))[0].data);
    const edit = (user, id, version, date, variety, plot, count) => asUser(user,
      "select edit_farm_shipment($1,$2,$3::date,$4,$5,$6)", [id, version, date, variety, plot, count]);

    await t.test("Admins and workers edit shipments; viewers and direct updates are denied", async () => {
      await assert.rejects(edit(viewer, "5", 0, "2026-09-05", 1, 2, 6), /FORBIDDEN/);
      await assert.rejects(asUser(worker, "update harvest_events set containers=20 where id=5"));
      await edit(worker, "5", 0, "2026-09-05", 1, 2, 6);
      const [updated] = await asUser(admin, "select *, harvest_date::text as harvest_date from harvest_events where id=5");
      assert.equal(updated.harvest_date, "2026-09-05");
      assert.equal(Number(updated.variety_id), 1);
      assert.equal(Number(updated.plot_id), 2);
      assert.equal(Number(updated.containers), 6);
      assert.equal(Number(updated.picking_cost), 780);
      assert.equal(updated.container_size, "קטן");
      assert.equal(updated.edit_version, 1);
      await assert.rejects(edit(admin, "5", 0, "2026-09-05", 1, 2, 6), /STALE_SHIPMENT/);
      await assert.rejects(edit(worker, "5", 1, "2026-09-05", 1, 2, 0), /INVALID_SHIPMENT/);
      const audit = await asUser(admin, "select * from audit_log where action='shipment_updated' and entity_id='5'");
      assert.equal(audit[0].actor_id, worker);
      assert.equal(audit[0].details.before.variety_id, 2);
      assert.equal(audit[0].details.after.variety_id, 1);
    });

    const example = receipt([
      { ...line({ containers: "2", net: "560", price: "1.8", amount: "1008" }), gross_weight: "657" },
      { ...line({ shipment: "2", variety: "1", net: "392", price: "3.5", amount: "1372" }), trader_date: "2026-09-09", gross_weight: "440" },
      { ...line({ shipment: "3", variety: "1", net: "387", price: "3.5", amount: "1355" }), trader_date: "2026-09-10", gross_weight: "435" },
    ], "3735");

    await t.test("Only active admins can manage receipts, even through direct calls", async () => {
      for (const user of [worker, viewer]) {
        await assert.rejects(save(example, true, user), /FORBIDDEN/);
        await assert.rejects(asUser(user, "select get_receipt_workspace()"), /FORBIDDEN/);
        assert.equal((await asUser(user, "select * from farm_receipts")).length, 0);
      }
      await assert.rejects(asUser(null, "select get_receipt_workspace()", [], "anon"));
      await assert.rejects(asUser(admin, "insert into farm_receipts (id, trader_id, payment_date) values ($1,1,current_date)", [randomUUID()]));
    });
    await t.test("Drafts do not consume capacity or add dashboard weight", async () => {
      const draft = receipt([],"0");
      const saved = await save(draft, false);
      assert.equal(saved.version, 1);
      assert.equal((await weights()).length, 0);
      const data = await workspace();
      assert.equal(data.receipts.length, 1);
      assert.equal(data.shipments.find((item) => item.id === "1").used_containers, 0);
    });
    await t.test("The supplied example confirms with trader dates and rounding intact", async () => {
      const result = await save(example);
      example.version = result.version; example.status = "confirmed";
      const data = await workspace();
      const saved = data.receipts.find((item) => item.id === example.id);
      assert.equal(saved.amount, "3735");
      assert.equal(saved.lines[2].amount, "1355");
      assert.equal(saved.lines[0].trader_date, "2026-09-07");
      assert.equal(data.shipments.find((item) => item.id === "1").harvest_date, "2026-09-06");
      assert.equal((await weights()).reduce((sum,item) => sum + Number(item.net_weight),0), 1339);
      assert.deepEqual(await weights(viewer), await weights(admin), "Dashboard exposes aggregates, not payment details");
    });
    await t.test("Editing does not double count and stale saves are rejected", async () => {
      const old = structuredClone(example);
      const updated = await save({ ...example, notes: "עודכן" });
      example.version = updated.version;
      assert.equal((await weights()).reduce((sum,item) => sum + Number(item.net_weight),0), 1339);
      await assert.rejects(save(old), /STALE_RECEIPT/);
    });
    await t.test("Shipment edits preserve receipt validity and cannot reduce paid capacity", async () => {
      await assert.rejects(edit(worker, "1", 0, "2026-09-06", 1, 1, 4), /LINKED_VARIETY/);
      await assert.rejects(edit(worker, "1", 0, "2026-09-06", 2, 1, 1), /BELOW_PAID_CONTAINERS/);
      await edit(worker, "1", 0, "2026-09-05", 2, 3, 4);
      const data = await workspace();
      assert.equal(data.shipments.find((item) => item.id === "1").harvest_date, "2026-09-05");
      assert.equal(data.shipments.find((item) => item.id === "1").plot_id, "3");
      assert.equal(Number((await weights()).find((item) => item.harvest_event_id === "1").net_weight), 560);
      assert.equal(data.receipts.find((item) => item.id === example.id).lines[0].trader_date, "2026-09-07");
    });
    await t.test("Rows can span shipments and a shipment can span rows and receipts", async () => {
      const shared = receipt([line({ containers: "2", net: "200", allocations: [
        { harvest_event_id: "1", containers: "1", net_weight: "100" },
        { harvest_event_id: "4", containers: "1", net_weight: "100" },
      ] })]);
      await save(shared);
      await save(receipt([line({ containers: "0.5", net: "50" }), line({ containers: "0.5", net: "50" })]));
      const h1 = (await weights()).find((item) => item.harvest_event_id === "1");
      assert.equal(Number(h1.containers), 4);
      assert.equal(Number(h1.net_weight), 760);
    });
    await t.test("Over-allocation and mismatched traders/varieties roll back completely", async () => {
      const tooMany = receipt();
      await assert.rejects(save(tooMany), /CONTAINER_CAPACITY_EXCEEDED/);
      assert.equal((await asUser(admin, "select * from farm_receipts where id=$1", [tooMany.id])).length, 0);
      await assert.rejects(save(receipt([line({ shipment: "5" })])), /SHIPMENT_MISMATCH/);
      await assert.rejects(save(receipt([line({ shipment: "2" })])), /SHIPMENT_MISMATCH/);
      const mismatch = line(); mismatch.allocations[0].net_weight = "99";
      await assert.rejects(save(receipt([mismatch])), /ALLOCATION_TOTAL_MISMATCH/);
      const inconsistent = line(); inconsistent.gross_weight = "100";
      await assert.rejects(save(receipt([inconsistent])), /INCOMPLETE_LINE/);
    });
    await t.test("Cancellation releases capacity, removes weight and preserves audit/history", async () => {
      await assert.rejects(asUser(worker, "select cancel_farm_receipt($1,$2,'test')", [example.id, example.version]), /FORBIDDEN/);
      await asUser(admin, "select cancel_farm_receipt($1,$2,'המחאה בוטלה')", [example.id, example.version]);
      assert.equal((await weights()).find((item) => item.harvest_event_id === "2"), undefined);
      await assert.rejects(save(example), /STALE_RECEIPT/);
      await save(receipt([line({ shipment: "2", variety: "1" })]));
      const audit = await asUser(admin, "select * from audit_log where action='receipt_cancelled' and entity_id=$1", [example.id]);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_id, admin);
      await assert.rejects(asUser(admin, "delete from harvest_events where id=2"), /foreign key/);
    });
    await t.test("Payment differences require explanation and are stored explicitly", async () => {
      const adjusted = receipt([line({ shipment: "3", variety: "1" })], "299.50");
      await assert.rejects(save(adjusted), /EXPLAIN_AMOUNT_DIFFERENCE/);
      adjusted.adjustment_reason = "הפרש עיגול במסמך הסוחר";
      await save(adjusted);
      const saved = (await workspace()).receipts.find((item) => item.id === adjusted.id);
      assert.equal(saved.amount, "299.5");
      assert.equal(saved.adjustment_reason, adjusted.adjustment_reason);
    });
    await t.test("Only admins delete drafts/cancelled receipts; confirmed and stale records are protected", async () => {
      const draft = receipt();
      draft.version = (await save(draft, false)).version;
      const remove = (item, user = admin, role = "authenticated") => asUser(user,
        "select delete_farm_receipt($1,$2)", [item.id, item.version], role);
      const beforeWeights = await weights();
      for (const user of [worker, viewer]) await assert.rejects(remove(draft, user), /FORBIDDEN/);
      await assert.rejects(remove(draft, "", "anon"), /permission denied/);
      await assert.rejects(asUser(admin, "delete from farm_receipts where id=$1", [draft.id]), /permission denied/);
      await assert.rejects(remove({ ...draft, version: draft.version - 1 }), /STALE_RECEIPT/);
      const confirmed = (await workspace()).receipts.find((item) => item.status === "confirmed");
      await assert.rejects(remove(confirmed), /CANNOT_DELETE_CONFIRMED/);
      for (const item of [draft, (await workspace()).receipts.find((record) => record.id === example.id)]) {
        const lineId = item.lines[0].id;
        await remove(item);
        assert.equal((await asUser(admin, "select * from farm_receipts where id=$1", [item.id])).length, 0);
        assert.equal((await asUser(admin, "select * from farm_receipt_lines where receipt_id=$1", [item.id])).length, 0);
        assert.equal((await asUser(admin, "select * from farm_receipt_allocations where line_id=$1", [lineId])).length, 0);
        const [audit] = await asUser(admin, "select * from audit_log where action='receipt_deleted' and entity_id=$1", [item.id]);
        assert.equal(audit.actor_id, admin);
        assert.equal(audit.details.before.lines[0].allocations[0].harvest_event_id, 1);
        await assert.rejects(remove(item), /STALE_RECEIPT/);
      }
      assert.deepEqual(await weights(), beforeWeights, "Deleting unpaid receipts leaves paid totals unchanged");
    });
    await t.test("Reports and private documents are admin-only, with real parent references", async () => {
      for (const user of [worker, viewer]) await assert.rejects(asUser(user, "select get_farm_reports()"), /FORBIDDEN/);
      await assert.rejects(asUser("", "select get_farm_reports()", [], "anon"), /permission denied/);
      const [report] = await asUser(admin, "select get_farm_reports() as data");
      assert.equal(report.data.shipments.length, 5);
      assert.equal(Number(report.data.shipments.find((s) => s.id === "5").picking_cost), 780);
      const [bucket] = (await db.query("select * from storage.buckets where id='farm-documents'")).rows;
      assert.equal(bucket.public, false); assert.equal(Number(bucket.file_size_limit), 10485760);
      const draft = receipt(); draft.version = (await save(draft, false)).version;
      const params = [draft.id, "receipt/test/file.pdf", "מסמך.pdf"];
      const insert = "insert into farm_documents(receipt_id,storage_path,file_name,mime_type,file_size) values ($1,$2,$3,'application/pdf',100) returning id";
      for (const user of [worker, viewer]) await assert.rejects(asUser(user, insert, params), /row-level security/);
      const [document] = await asUser(admin, insert, params);
      assert.equal((await asUser(worker, "select * from farm_documents")).length, 0);
      assert.equal((await asUser(viewer, "delete from farm_documents returning id")).length, 0);
      await assert.rejects(asUser(admin, "select delete_farm_receipt($1,$2)", [draft.id, draft.version]), /foreign key/);
      await assert.rejects(asUser(admin, insert, [randomUUID(), "missing.pdf", "missing.pdf"]), /foreign key/);
      await asUser(admin, "insert into storage.objects(bucket_id,name) values ('farm-documents','test.pdf')");
      assert.equal((await asUser(worker, "select * from storage.objects")).length, 0);
      await assert.rejects(asUser(worker, "insert into storage.objects(bucket_id,name) values ('farm-documents','bad.pdf')"), /row-level security/);
      assert.equal((await asUser(viewer, "delete from storage.objects returning id")).length, 0);
      await asUser(admin, "delete from farm_documents where id=$1", [document.id]);
      await asUser(admin, "select delete_farm_receipt($1,$2)", [draft.id, draft.version]);
    });
    await t.test("Shipment trader editing validates roles, versions and receipt links atomically", async () => {
      for (const user of [admin, worker]) assert.equal((await asUser(user, "select * from get_shipment_traders()")).length, 2);
      await assert.rejects(asUser(viewer, "select * from get_shipment_traders()"), /FORBIDDEN/);
      const [shipment] = (await db.query("insert into harvest_events(trader_id,harvest_date,variety_id,plot_id,containers,container_size) values (1,'2026-09-10',2,1,3,'קטן') returning id::text as id")).rows;
      const change = (user, version, trader, count = 3, role = "authenticated") => asUser(user,
        "select edit_farm_shipment_with_trader($1,$2,'2026-09-10',2,1,$3,$4)", [shipment.id, version, count, trader], role);
      await assert.rejects(change(viewer, 0, "2"), /FORBIDDEN/);
      await assert.rejects(change("", 0, "2", 3, "anon"), /permission denied/);
      await assert.rejects(change(admin, 0, "999"), /INVALID_TRADER/);
      await assert.rejects(change(admin, 0, "2", 0), /INVALID_SHIPMENT/);
      await change(worker, 0, "2");
      const [updated] = await asUser(admin, "select trader_id,edit_version from harvest_events where id::text=$1", [shipment.id]);
      assert.equal(Number(updated.trader_id), 2); assert.equal(updated.edit_version, 1);
      await assert.rejects(change(admin, 0, "1"), /STALE_SHIPMENT/);
      await change(admin, 1, "1");
      const draft = receipt([line({ shipment: shipment.id })]);
      draft.version = (await save(draft, false)).version;
      await assert.rejects(change(admin, 2, "2"), /LINKED_TRADER/);
      await change(worker, 2, "1"); // Unchanged trader still permits other edits.
      draft.version = (await save(draft, true)).version;
      await assert.rejects(change(worker, 3, "2"), /LINKED_TRADER/);
      assert.equal(Number((await asUser(admin, "select trader_id from harvest_events where id::text=$1", [shipment.id]))[0].trader_id), 1);
      await asUser(admin, "select cancel_farm_receipt($1,$2,'תיקון סוחר')", [draft.id, draft.version]);
      await change(admin, 3, "2");
      const [audit] = await asUser(admin, "select * from audit_log where action='shipment_trader_updated' and entity_id=$1 order by id desc", [shipment.id]);
      assert.equal(audit.details.before.trader_id, 1); assert.equal(audit.details.after.trader_id, 2);
      assert.equal(audit.details.after.edit_version, 4);
    });
    await t.test("Settings and catalogs preserve areas, accept new IDs and enforce admin-only versioned writes", async () => {
      const get = async (user=admin)=>(await asUser(user,"select get_farm_catalog() as data"))[0].data;
      const initial=await get();
      assert.equal(initial.settings.overdue_days,14);assert.equal(Number(initial.plots[0].dunam),10);
      assert.equal(initial.varieties[1].name,"גליל");assert.equal((await get(viewer)).plots.length,3);
      await assert.rejects(asUser("","select get_farm_catalog()",[],"anon"),/permission denied/);
      for(const user of [worker,viewer]){
        await assert.rejects(asUser(user,"select admin_save_farm_settings(0,30,12)"),/FORBIDDEN/);
        await assert.rejects(asUser(user,"select admin_save_catalog('plots',null,0,'אסור',true,10)"),/FORBIDDEN/);
        await assert.rejects(asUser(user,"update plots set dunam=999 where id=1"),/permission denied/);
      }
      await asUser(admin,"select admin_save_farm_settings(0,30,12.5)");
      await assert.rejects(asUser(admin,"select admin_save_farm_settings(0,3,2)"),/STALE_SETTINGS/);
      await assert.rejects(asUser(admin,"select admin_save_farm_settings(1,-1,2)"),/INVALID_SETTINGS/);
      const saveEntry=async(kind,id,version,name,active=true,area=null)=>(await asUser(admin,"select admin_save_catalog($1,$2,$3,$4,$5,$6) as id",[kind,id,version,name,active,area]))[0].id;
      await assert.rejects(saveEntry("plots",null,0,"כביש 70",true,20),/DUPLICATE_CATALOG/);
      await assert.rejects(saveEntry("plots",null,0,"שטח שלילי",true,-2),/INVALID_CATALOG/);
      const plot=await saveEntry("plots",null,0,"חלקה חדשה",true,12.5);
      const variety=await saveEntry("varieties",null,0,"זן חדש");
      const trader=await saveEntry("traders",null,0,"סוחר חדש");
      assert.equal(plot,"4");assert.equal(variety,"5");assert.equal(trader,"3");
      const [shipment]=await asUser(worker,"insert into harvest_events(trader_id,harvest_date,variety_id,plot_id,containers,container_size) values($1,'2026-09-11',$2,$3,2,'קטן') returning id::text as id",[trader,variety,plot]);
      await asUser(worker,"select edit_farm_shipment_with_trader($1,0,'2026-09-11',$2,$3,2,$4)",[shipment.id,Number(variety),Number(plot),trader]);
      const item=receipt([line({shipment:shipment.id,variety})]);item.trader_id=trader;item.version=(await save(item)).version;
      await saveEntry("plots",plot,0,"חלקה מעודכנת",true,15);
      await assert.rejects(saveEntry("plots",plot,0,"דריסה",true,99),/STALE_SETTINGS/);
      await saveEntry("varieties",variety,0,"זן חדש",false);
      item.version=(await save({...item,notes:"תיקון הערה בזן היסטורי"})).version;
      const newReceipt=receipt([line({shipment:shipment.id,variety})]);newReceipt.trader_id=trader;
      await assert.rejects(save(newReceipt,false),/INVALID_LINE/);
      await assert.rejects(asUser(worker,"insert into harvest_events(trader_id,harvest_date,variety_id,plot_id,containers) values($1,'2026-09-11',$2,$3,1)",[trader,variety,plot]),/INACTIVE_CATALOG/);
      await saveEntry("traders",trader,0,"שם סוחר מעודכן",true);
      const report=(await asUser(admin,"select get_farm_reports() as data"))[0].data;
      assert.equal(report.traders.find(t=>t.id===trader).name,"שם סוחר מעודכן");
      assert.equal(Number((await get()).plots.find(p=>p.id===plot).dunam),15);
      assert.equal(Number((await asUser(admin,"select dunam from plots where id=1"))[0].dunam),10,"Existing dunam is preserved");
      const [legacyName]=await asUser(admin,"select plot_name from plots where id::text=$1",[plot]);assert.equal(legacyName.plot_name,"חלקה מעודכנת");
      for(const v of (await get()).varieties.filter(v=>v.active&&v.id!=="1"))await saveEntry("varieties",v.id,v.version,v.name,false);
      await assert.rejects(saveEntry("varieties","1",0,"אטינגר",false),/LAST_ACTIVE_CATALOG/);
      assert.ok((await asUser(admin,"select * from audit_log where action='catalog_updated'")).length>=6);
    });
    await t.test("Picking defaults affect new shipments only and edits preserve historical costs",async()=>{
      await db.exec("update harvest_events set picking_cost=401 where id=1; update harvest_events set picking_cost=null where id=2");
      const before=(await db.query("select id,picking_cost from harvest_events order by id")).rows;
      await db.exec(await read("supabase/migrations/009_picking_rates.sql"));
      assert.deepEqual((await db.query("select id,picking_cost from harvest_events order by id")).rows,before);
      const settings=(await asUser(admin,"select get_farm_catalog() as c"))[0].c.settings;
      const v=settings.version;
      for(const user of [worker,viewer])await assert.rejects(asUser(user,"select admin_save_farm_settings_with_picking($1,14,10,180,220)",[v]),/FORBIDDEN/);
      await assert.rejects(asUser(admin,"select admin_save_farm_settings_with_picking($1,14,10,-1,220)",[v]),/INVALID_SETTINGS/);
      await asUser(admin,"select admin_save_farm_settings_with_picking($1,14,10,180,220)",[v]);
      await assert.rejects(asUser(admin,"select admin_save_farm_settings_with_picking($1,14,10,180,220)",[v]),/STALE_SETTINGS/);
      assert.deepEqual((await db.query("select id,picking_cost from harvest_events order by id")).rows,before);
      const insert=async(size)=>(await asUser(worker,"insert into harvest_events(trader_id,harvest_date,variety_id,plot_id,containers,container_size,picking_cost,picking_rate) values(1,'2026-10-01',1,1,3,$1,1,1) returning *",[size]))[0];
      const small=await insert('קטן'),large=await insert('גדול');
      assert.equal(Number(small.picking_rate),180);assert.equal(Number(small.picking_cost),540);
      assert.equal(Number(large.picking_rate),220);assert.equal(Number(large.picking_cost),660);
      const change=async(user,version,count,rate=null)=>(await asUser(user,"select edit_farm_shipment_with_picking($1,$2,'2026-10-02',1,1,$3,'1',$4) as c",[String(small.id),version,count,rate]))[0].c;
      await assert.rejects(change(worker,0,3,99),/FORBIDDEN/);
      await assert.rejects(change(viewer,0,3),/FORBIDDEN/);
      await assert.rejects(change(admin,0,3,-1),/INVALID_PICKING_RATE/);
      await asUser(admin,"select admin_save_farm_settings_with_picking($1,14,10,250,300)",[v+1]);
      assert.equal(Number((await change(worker,0,3)).picking_cost),540);
      assert.equal(Number((await change(worker,1,4)).picking_cost),720);
      assert.equal(Number((await change(admin,2,4,100.25)).picking_cost),401);
      await assert.rejects(change(admin,2,4,1),/STALE_SHIPMENT/);
      assert.equal(Number((await change(worker,3,5)).picking_cost),501.25);
      // An old client uses the same preserved rate through the original RPC.
      await asUser(worker,"select edit_farm_shipment_with_trader($1,4,'2026-10-02',1,1,6,'1')",[String(small.id)]);
      assert.equal(Number((await db.query("select picking_cost from harvest_events where id=$1",[small.id])).rows[0].picking_cost),601.5);
      assert.equal((await db.query("select picking_rate from harvest_events where id=2")).rows[0].picking_rate,null);
      assert.ok((await asUser(admin,"select * from audit_log where action='shipment_picking_updated'")).length);
    });
  } finally { await db.close(); }
});
