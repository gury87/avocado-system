-- Requires 001_users.sql and 002_secure_farm.sql. Run once in SQL Editor.
-- Creates dedicated tables; does not overwrite existing payment/settlement tables.
begin;

create table public.farm_receipts (
  id uuid primary key,
  version integer not null default 1,
  trader_id bigint not null references public.traders(id),
  payment_date date not null,
  received_date date,
  method text not null default 'cheque' check (method in ('cheque', 'bank', 'cash')),
  amount numeric(14,2) not null default 0 check (amount >= 0 and amount <> 'NaN'::numeric),
  reference text not null default '',
  notes text not null default '',
  adjustment_reason text not null default '',
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancellation_reason text,
  cancelled_at timestamptz
);
create table public.farm_receipt_lines (
  id uuid primary key,
  receipt_id uuid not null references public.farm_receipts(id) on delete cascade,
  position integer not null,
  trader_date date,
  variety_id bigint not null,
  gross_weight numeric(14,3) not null default 0 check (gross_weight >= 0 and gross_weight <> 'NaN'::numeric),
  containers numeric(12,3) not null default 0 check (containers >= 0 and containers <> 'NaN'::numeric),
  tare_weight numeric(10,3) not null default 40 check (tare_weight >= 0 and tare_weight <> 'NaN'::numeric),
  net_weight numeric(14,3) not null default 0 check (net_weight >= 0 and net_weight <> 'NaN'::numeric),
  price_per_kg numeric(12,4) not null default 0 check (price_per_kg >= 0 and price_per_kg <> 'NaN'::numeric),
  amount numeric(14,2) not null default 0 check (amount >= 0 and amount <> 'NaN'::numeric),
  unique (receipt_id, position)
);

-- Use the actual harvest_events.id type (bigint, integer or uuid).
do $$
declare id_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into id_type
  from pg_attribute a where a.attrelid = 'public.harvest_events'::regclass and a.attname = 'id' and not a.attisdropped;
  if id_type is null then raise exception 'harvest_events.id is missing'; end if;
  execute format('create table public.farm_receipt_allocations (
    line_id uuid not null references public.farm_receipt_lines(id) on delete cascade,
    harvest_event_id %s not null references public.harvest_events(id) on delete restrict,
    containers numeric(12,3) not null check (containers > 0 and containers <> ''NaN''::numeric),
    net_weight numeric(14,3) not null check (net_weight >= 0 and net_weight <> ''NaN''::numeric),
    primary key (line_id, harvest_event_id)
  )', id_type);
end;
$$;
create index farm_receipt_allocations_harvest on public.farm_receipt_allocations(harvest_event_id);
create index farm_receipt_lines_receipt on public.farm_receipt_lines(receipt_id);
create index farm_receipts_date on public.farm_receipts(payment_date desc);

alter table public.farm_receipts enable row level security;
alter table public.farm_receipt_lines enable row level security;
alter table public.farm_receipt_allocations enable row level security;
revoke all on public.farm_receipts, public.farm_receipt_lines, public.farm_receipt_allocations from anon, authenticated;
grant select on public.farm_receipts, public.farm_receipt_lines, public.farm_receipt_allocations to authenticated;
create policy receipts_admin_read on public.farm_receipts for select to authenticated using ((select private.farm_role()) = 'admin');
create policy receipt_lines_admin_read on public.farm_receipt_lines for select to authenticated using ((select private.farm_role()) = 'admin');
create policy receipt_allocations_admin_read on public.farm_receipt_allocations for select to authenticated using ((select private.farm_role()) = 'admin');

create function public.save_farm_receipt(payload jsonb, finalize boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  rid uuid;
  previous public.farm_receipts;
  item jsonb;
  allocation jsonb;
  v_line_id uuid;
  next_status text;
  line_position integer := 0;
  line_containers numeric;
  line_net numeric;
  allocated_containers numeric;
  allocated_net numeric;
  saved_version integer;
  total_amount numeric;
begin
  perform pg_advisory_xact_lock(84123, 2);
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if payload is null or jsonb_typeof(payload) <> 'object' or finalize is null
    or jsonb_typeof(payload->'lines') is distinct from 'array'
    or jsonb_array_length(payload->'lines') > 100 then raise exception 'INVALID_RECEIPT'; end if;
  rid := (payload->>'id')::uuid;
  if rid is null or payload->>'payment_date' is null or payload->>'trader_id' is null then raise exception 'INVALID_RECEIPT'; end if;
  select * into previous from public.farm_receipts where id = rid for update;
  if found then
    if previous.version is distinct from (payload->>'version')::integer then raise exception 'STALE_RECEIPT'; end if;
    if previous.status = 'cancelled' then raise exception 'CANCELLED_RECEIPT'; end if;
    if previous.status = 'confirmed' and not finalize then raise exception 'CANNOT_UNCONFIRM'; end if;
  elsif coalesce((payload->>'version')::integer, 0) <> 0 then raise exception 'STALE_RECEIPT';
  end if;
  next_status := case when finalize then 'confirmed' else 'draft' end;

  -- Lock all referenced shipments before allocations change. FK RESTRICT also
  -- prevents deleting a shipment whose receipt history must be preserved.
  perform h.id from public.harvest_events h
  where h.id::text in (
    select a->>'harvest_event_id' from jsonb_array_elements(payload->'lines') l
    cross join lateral jsonb_array_elements(coalesce(l->'allocations', '[]'::jsonb)) a
  ) order by h.id for update;

  insert into public.farm_receipts (id, trader_id, payment_date, received_date, method, amount,
    reference, notes, adjustment_reason, status, created_by, updated_by)
  values (rid, (payload->>'trader_id')::bigint, (payload->>'payment_date')::date,
    nullif(payload->>'received_date', '')::date, payload->>'method', coalesce(nullif(payload->>'amount', '')::numeric, 0),
    coalesce(payload->>'reference', ''), coalesce(payload->>'notes', ''), coalesce(payload->>'adjustment_reason', ''), next_status, auth.uid(), auth.uid())
  on conflict (id) do update set
    trader_id = excluded.trader_id, payment_date = excluded.payment_date, received_date = excluded.received_date,
    method = excluded.method, amount = excluded.amount, reference = excluded.reference, notes = excluded.notes,
    adjustment_reason = excluded.adjustment_reason, status = excluded.status,
    updated_by = auth.uid(), updated_at = now(), version = public.farm_receipts.version + 1
  returning version into saved_version;

  delete from public.farm_receipt_lines where receipt_id = rid;
  for item in select value from jsonb_array_elements(payload->'lines') loop
    line_position := line_position + 1;
    v_line_id := (item->>'id')::uuid;
    if v_line_id is null or coalesce(item->>'variety_id', '') not in ('1','2','3','4') then raise exception 'INVALID_LINE'; end if;
    if jsonb_typeof(item->'allocations') is distinct from 'array' or jsonb_array_length(item->'allocations') > 100 then raise exception 'INVALID_ALLOCATION'; end if;
    insert into public.farm_receipt_lines (id, receipt_id, position, trader_date, variety_id,
      gross_weight, containers, tare_weight, net_weight, price_per_kg, amount)
    values (v_line_id, rid, line_position, nullif(item->>'trader_date', '')::date, (item->>'variety_id')::bigint,
      coalesce(nullif(item->>'gross_weight','')::numeric,0), coalesce(nullif(item->>'containers','')::numeric,0),
      coalesce(nullif(item->>'tare_weight','')::numeric,40), coalesce(nullif(item->>'net_weight','')::numeric,0),
      coalesce(nullif(item->>'price_per_kg','')::numeric,0), coalesce(nullif(item->>'amount','')::numeric,0));

    if finalize and exists (select 1 from public.farm_receipt_lines l where l.id = v_line_id
      and (l.trader_date is null or l.containers <= 0 or l.net_weight <= 0 or l.price_per_kg <= 0
        or l.amount <= 0 or l.gross_weight < l.net_weight + l.containers * l.tare_weight)) then
      raise exception 'INCOMPLETE_LINE';
    end if;

    for allocation in select value from jsonb_array_elements(item->'allocations') loop
      if not exists (select 1 from public.harvest_events h where h.id::text = allocation->>'harvest_event_id'
        and h.trader_id::text = payload->>'trader_id' and h.variety_id::text = item->>'variety_id') then
        raise exception 'SHIPMENT_MISMATCH';
      end if;
      insert into public.farm_receipt_allocations (line_id, harvest_event_id, containers, net_weight)
      select v_line_id, h.id, (allocation->>'containers')::numeric, (allocation->>'net_weight')::numeric
      from public.harvest_events h where h.id::text = allocation->>'harvest_event_id';
    end loop;

    if finalize then
      select l.containers, l.net_weight into line_containers, line_net from public.farm_receipt_lines l where l.id = v_line_id;
      select coalesce(sum(a.containers),0), coalesce(sum(a.net_weight),0) into allocated_containers, allocated_net
      from public.farm_receipt_allocations a where a.line_id = v_line_id;
      if line_containers <> allocated_containers or line_net <> allocated_net then raise exception 'ALLOCATION_TOTAL_MISMATCH'; end if;
    end if;
  end loop;

  if finalize then
    if line_position = 0 or (select amount from public.farm_receipts where id = rid) <= 0 then raise exception 'EMPTY_RECEIPT'; end if;
    if exists (
      select h.id from public.harvest_events h
      join public.farm_receipt_allocations a on a.harvest_event_id = h.id
      join public.farm_receipt_lines l on l.id = a.line_id
      join public.farm_receipts r on r.id = l.receipt_id and r.status = 'confirmed'
      where h.id in (select a2.harvest_event_id from public.farm_receipt_allocations a2
        join public.farm_receipt_lines l2 on l2.id = a2.line_id where l2.receipt_id = rid)
      group by h.id, h.containers having sum(a.containers) > h.containers
    ) then raise exception 'CONTAINER_CAPACITY_EXCEEDED'; end if;
    select sum(amount) into total_amount from public.farm_receipt_lines where receipt_id = rid;
    if exists (select 1 from public.farm_receipts where id = rid and amount <> total_amount and length(trim(adjustment_reason)) = 0) then
      raise exception 'EXPLAIN_AMOUNT_DIFFERENCE';
    end if;
  end if;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), case when finalize then 'receipt_confirmed' else 'receipt_draft_saved' end, rid::text,
    jsonb_build_object('previous_status', previous.status, 'version', saved_version, 'receipt', payload));
  return jsonb_build_object('id', rid, 'version', saved_version);
end;
$$;
revoke all on function public.save_farm_receipt(jsonb, boolean) from public, anon;
grant execute on function public.save_farm_receipt(jsonb, boolean) to authenticated;

create function public.cancel_farm_receipt(receipt_id uuid, expected_version integer, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare previous public.farm_receipts;
begin
  perform pg_advisory_xact_lock(84123, 2);
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if reason is null or length(trim(reason)) = 0 then raise exception 'CANCELLATION_REASON_REQUIRED'; end if;
  select * into previous from public.farm_receipts where id = receipt_id for update;
  if not found or previous.version is distinct from expected_version then raise exception 'STALE_RECEIPT'; end if;
  if previous.status = 'cancelled' then raise exception 'CANCELLED_RECEIPT'; end if;
  update public.farm_receipts set status = 'cancelled', cancellation_reason = trim(reason), cancelled_at = now(),
    updated_at = now(), updated_by = auth.uid(), version = version + 1 where id = receipt_id;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), 'receipt_cancelled', receipt_id::text, jsonb_build_object('reason', trim(reason), 'previous', to_jsonb(previous)));
end;
$$;
revoke all on function public.cancel_farm_receipt(uuid, integer, text) from public, anon;
grant execute on function public.cancel_farm_receipt(uuid, integer, text) to authenticated;

create function public.get_paid_shipment_weights() returns table(harvest_event_id text, net_weight numeric, containers numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.farm_role() is null then raise exception 'FORBIDDEN'; end if;
  return query select a.harvest_event_id::text, sum(a.net_weight), sum(a.containers)
  from public.farm_receipt_allocations a
  join public.farm_receipt_lines l on l.id = a.line_id
  join public.farm_receipts r on r.id = l.receipt_id and r.status = 'confirmed'
  group by a.harvest_event_id;
end;
$$;
revoke all on function public.get_paid_shipment_weights() from public, anon;
grant execute on function public.get_paid_shipment_weights() to authenticated;

create function public.get_receipt_workspace() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  return jsonb_build_object(
    'traders', coalesce((select jsonb_agg(jsonb_build_object('id', t.id::text, 'name',
      case when t.id::text = '1' then 'ראובן יהודה' else coalesce(to_jsonb(t)->>'name', to_jsonb(t)->>'trader_name', 'סוחר ' || t.id::text) end) order by t.id) from public.traders t), '[]'::jsonb),
    'shipments', coalesce((select jsonb_agg(jsonb_build_object('id', h.id::text, 'harvest_date', h.harvest_date,
      'trader_id', h.trader_id::text, 'variety_id', h.variety_id::text, 'plot_id', h.plot_id::text,
      'containers', h.containers, 'used_containers', coalesce((select sum(a.containers)
        from public.farm_receipt_allocations a join public.farm_receipt_lines l on l.id = a.line_id
        join public.farm_receipts r on r.id = l.receipt_id and r.status = 'confirmed' where a.harvest_event_id = h.id), 0))
      order by h.harvest_date desc nulls last, h.id desc) from public.harvest_events h), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('lines', coalesce((
      select jsonb_agg(to_jsonb(l) || jsonb_build_object('allocations', coalesce((
        select jsonb_agg(jsonb_build_object('harvest_event_id', a.harvest_event_id::text, 'containers', a.containers, 'net_weight', a.net_weight)
          order by a.harvest_event_id) from public.farm_receipt_allocations a where a.line_id = l.id), '[]'::jsonb)) order by l.position)
        from public.farm_receipt_lines l where l.receipt_id = r.id), '[]'::jsonb))
      order by r.payment_date desc, r.created_at desc) from public.farm_receipts r), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_receipt_workspace() from public, anon;
grant execute on function public.get_receipt_workspace() to authenticated;
notify pgrst, 'reload schema';
commit;
