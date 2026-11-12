-- Run once after 010. containers remains the physical receipt capacity.
begin;
lock table public.harvest_events in access exclusive mode;
alter table public.harvest_events add column harvest_quantity numeric;
-- The backfill adds a quantity snapshot, without changing any historical cost,
-- allocation, edit version or confirmed-payment protection.
alter table public.harvest_events disable trigger harvest_protect_paid;
update public.harvest_events set harvest_quantity=containers;
alter table public.harvest_events enable trigger harvest_protect_paid;
alter table public.harvest_events alter column harvest_quantity set not null;
alter table public.harvest_events add constraint harvest_quantity_valid
  check(harvest_quantity>0 and harvest_quantity<=1000000 and harvest_quantity=round(harvest_quantity,2));
alter table public.harvest_events add constraint harvest_physical_quantity
  check(containers=ceil(harvest_quantity));

create or replace function private.snapshot_picking_rate() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(84123,2);
  new.harvest_quantity:=coalesce(new.harvest_quantity,new.containers);
  if new.harvest_quantity is null or new.harvest_quantity<=0 or new.harvest_quantity>1000000
    or new.harvest_quantity<>round(new.harvest_quantity,2) then raise exception 'INVALID_SHIPMENT'; end if;
  new.containers:=ceil(new.harvest_quantity);
  if new.container_size is null or new.container_size not in ('קטן','גדול') then raise exception 'INVALID_CONTAINER_SIZE'; end if;
  select case when new.container_size='גדול' then picking_rate_large else picking_rate_small end
    into new.picking_rate from public.farm_settings where id;
  new.picking_cost:=round(new.harvest_quantity*new.picking_rate,2);
  return new;
end;
$$;
create or replace function private.edit_shipment_quantity(target_id text, expected_version integer,
  new_date date, new_variety_id bigint, new_plot_id bigint, new_containers numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous public.harvest_events;
  updated public.harvest_events;
  allocated numeric;
begin
  -- Same lock as receipt confirmation/cancellation: quantities cannot race.
  perform pg_advisory_xact_lock(84123, 2);
  if coalesce(private.farm_role(), '') not in ('admin', 'worker') then raise exception 'FORBIDDEN'; end if;
  if new_date is null or new_variety_id is null or not exists(select 1 from public.varieties where id=new_variety_id)
    or new_plot_id is null or not exists(select 1 from public.plots where id=new_plot_id) or new_containers is null
    or new_containers <= 0 or new_containers = 'NaN'::numeric
    or new_containers <> round(new_containers,2) or new_containers > 1000000 then raise exception 'INVALID_SHIPMENT'; end if;
  select * into previous from public.harvest_events where id::text = target_id for update;
  if not found then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  if previous.edit_version is distinct from expected_version then raise exception 'STALE_SHIPMENT'; end if;
  if (new_variety_id is distinct from previous.variety_id and not exists(select 1 from public.varieties where id=new_variety_id and farm_active)) or (new_plot_id is distinct from previous.plot_id and not exists(select 1 from public.plots where id=new_plot_id and farm_active)) then raise exception 'INACTIVE_CATALOG'; end if;
  if new_variety_id <> previous.variety_id and exists (
    select 1 from public.farm_receipt_allocations a join public.farm_receipt_lines l on l.id = a.line_id
    join public.farm_receipts r on r.id = l.receipt_id
    where a.harvest_event_id = previous.id and r.status <> 'cancelled'
  ) then raise exception 'LINKED_VARIETY'; end if;
  select coalesce(sum(a.containers),0) into allocated from public.farm_receipt_allocations a
    join public.farm_receipt_lines l on l.id = a.line_id
    join public.farm_receipts r on r.id = l.receipt_id and r.status = 'confirmed'
    where a.harvest_event_id = previous.id;
  if ceil(new_containers) < allocated then raise exception 'BELOW_PAID_CONTAINERS'; end if;
  update public.harvest_events set harvest_date = new_date, variety_id = new_variety_id,
    plot_id = new_plot_id, containers = ceil(new_containers), harvest_quantity = new_containers,
    picking_cost = case when new_containers = previous.harvest_quantity then previous.picking_cost else round(new_containers * previous.picking_rate, 2) end,
    edit_version = edit_version + 1 where id = previous.id returning * into updated;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), 'shipment_updated', target_id, jsonb_build_object('before', to_jsonb(previous), 'after', to_jsonb(updated)));
  return jsonb_build_object('id', updated.id::text, 'edit_version', updated.edit_version);
end;
$$;
revoke all on function private.edit_shipment_quantity(text,integer,date,bigint,bigint,numeric) from public,anon,authenticated;
create function private.edit_shipment_quantity_with_trader(target_id text, expected_version integer,
  new_date date, new_variety_id bigint, new_plot_id bigint, new_containers numeric, new_trader_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous public.harvest_events;
  updated public.harvest_events;
  trader public.traders;
  result jsonb;
begin
  perform pg_advisory_xact_lock(84123, 2);
  if coalesce(private.farm_role(), '') not in ('admin', 'worker') then raise exception 'FORBIDDEN'; end if;
  select * into previous from public.harvest_events h where h.id::text = target_id for update;
  if not found then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  if previous.edit_version is distinct from expected_version then raise exception 'STALE_SHIPMENT'; end if;
  select * into trader from public.traders t where t.id::text = new_trader_id and (t.farm_active or t.id=previous.trader_id) for key share;
  if not found then raise exception 'INVALID_TRADER'; end if;
  if previous.trader_id is distinct from trader.id and exists (
    select 1 from public.farm_receipt_allocations a join public.farm_receipt_lines l on l.id = a.line_id
    join public.farm_receipts r on r.id = l.receipt_id
    where a.harvest_event_id = previous.id and r.status <> 'cancelled'
  ) then raise exception 'LINKED_TRADER'; end if;
  -- Reuse all existing quantity, variety, authorization and concurrency checks.
  result := private.edit_shipment_quantity(target_id, expected_version, new_date, new_variety_id, new_plot_id, new_containers);
  if previous.trader_id is distinct from trader.id then
    update public.harvest_events set trader_id = trader.id where id = previous.id returning * into updated;
    insert into public.audit_log(actor_id, action, entity_id, details)
      values (auth.uid(), 'shipment_trader_updated', target_id, jsonb_build_object('before', to_jsonb(previous), 'after', to_jsonb(updated)));
  end if;
  return result;
end;
$$;
revoke all on function private.edit_shipment_quantity_with_trader(text,integer,date,bigint,bigint,numeric,text) from public,anon,authenticated;
create function public.edit_farm_shipment_quantity(target_id text,expected_version integer,new_date date,
 new_variety_id bigint,new_plot_id bigint,new_containers numeric,new_trader_id text,new_picking_rate numeric default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.harvest_events; updated public.harvest_events; result jsonb;
begin
  perform pg_advisory_xact_lock(84123,2);
  if coalesce(private.farm_role(),'') not in ('admin','worker') then raise exception 'FORBIDDEN'; end if;
  select * into previous from public.harvest_events where id::text=target_id for update;
  if not found then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  if new_picking_rate is not null then
    if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
    if new_picking_rate not between 0 and 1000000 then raise exception 'INVALID_PICKING_RATE'; end if;
  end if;
  result := private.edit_shipment_quantity_with_trader(target_id,expected_version,new_date,new_variety_id,new_plot_id,new_containers,new_trader_id);
  if new_picking_rate is not null and new_picking_rate is distinct from previous.picking_rate then
    update public.harvest_events set picking_rate=new_picking_rate,picking_cost=round(new_containers*new_picking_rate,2)
      where id=previous.id returning * into updated;
    insert into public.audit_log(actor_id,action,entity_id,details) values(auth.uid(),'shipment_picking_updated',target_id,
      jsonb_build_object('before',to_jsonb(previous),'after',to_jsonb(updated)));
  end if;
  select * into updated from public.harvest_events where id=previous.id;
  return result || jsonb_build_object('harvest_quantity',updated.harvest_quantity,'containers',updated.containers,'picking_rate',updated.picking_rate,'picking_cost',updated.picking_cost);
end;
$$;
revoke all on function public.edit_farm_shipment_quantity(text,integer,date,bigint,bigint,numeric,text,numeric) from public,anon;
grant execute on function public.edit_farm_shipment_quantity(text,integer,date,bigint,bigint,numeric,text,numeric) to authenticated;

-- Compatibility with older clients: unchanged physical count preserves the
-- reported quantity. Actual quantity changes should use the new endpoint.
create or replace function public.edit_farm_shipment(target_id text, expected_version integer,
 new_date date,new_variety_id bigint,new_plot_id bigint,new_containers numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.harvest_events;
begin
  perform pg_advisory_xact_lock(84123,2);
  if coalesce(private.farm_role(),'') not in ('admin','worker') then raise exception 'FORBIDDEN'; end if;
  select * into previous from public.harvest_events where id::text=target_id for update;
  return private.edit_shipment_quantity(target_id,expected_version,new_date,new_variety_id,new_plot_id,
    case when new_containers=previous.containers then previous.harvest_quantity else new_containers end);
end;
$$;
-- Legacy rate editor also multiplies by reported quantity, not physical count.
create or replace function public.edit_farm_shipment_with_picking(target_id text,expected_version integer,new_date date,
 new_variety_id bigint,new_plot_id bigint,new_containers numeric,new_trader_id text,new_picking_rate numeric default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous public.harvest_events; updated public.harvest_events; result jsonb;
begin
  perform pg_advisory_xact_lock(84123,2);
  if coalesce(private.farm_role(),'') not in ('admin','worker') then raise exception 'FORBIDDEN'; end if;
  select * into previous from public.harvest_events where id::text=target_id for update;
  if not found then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  if new_picking_rate is not null then
    if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
    if new_picking_rate not between 0 and 1000000 then raise exception 'INVALID_PICKING_RATE'; end if;
  end if;
  result := public.edit_farm_shipment_with_trader(target_id,expected_version,new_date,new_variety_id,new_plot_id,new_containers,new_trader_id);
  if new_picking_rate is not null and new_picking_rate is distinct from previous.picking_rate then
    update public.harvest_events set picking_rate=new_picking_rate,picking_cost=round(harvest_quantity*new_picking_rate,2)
      where id=previous.id returning * into updated;
    insert into public.audit_log(actor_id,action,entity_id,details) values(auth.uid(),'shipment_picking_updated',target_id,
      jsonb_build_object('before',to_jsonb(previous),'after',to_jsonb(updated)));
  end if;
  select * into updated from public.harvest_events where id=previous.id;
  return result || jsonb_build_object('picking_rate',updated.picking_rate,'picking_cost',updated.picking_cost);
end;
$$;
revoke all on function public.edit_farm_shipment_with_picking(text,integer,date,bigint,bigint,numeric,text,numeric) from public,anon;
grant execute on function public.edit_farm_shipment_with_picking(text,integer,date,bigint,bigint,numeric,text,numeric) to authenticated;
create or replace function public.get_receipt_workspace() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  return jsonb_build_object(
    'traders', coalesce((select jsonb_agg(jsonb_build_object('id', t.id::text, 'name',
      t.farm_name) order by t.id) from public.traders t), '[]'::jsonb),
    'shipments', coalesce((select jsonb_agg(jsonb_build_object('id', h.id::text, 'harvest_date', h.harvest_date,
      'trader_id', h.trader_id::text, 'variety_id', h.variety_id::text, 'plot_id', h.plot_id::text,
      'harvest_quantity',h.harvest_quantity,'containers', h.containers, 'used_containers', coalesce((select sum(a.containers)
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

create or replace function public.get_farm_reports() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  result := public.get_receipt_workspace();
  return result || jsonb_build_object('shipments', coalesce((
    select jsonb_agg(jsonb_build_object('id', h.id::text, 'harvest_date', h.harvest_date,
      'trader_id', h.trader_id::text, 'variety_id', h.variety_id::text, 'plot_id', h.plot_id::text,
      'harvest_quantity',h.harvest_quantity,'containers', h.containers, 'picking_cost', h.picking_cost)
      order by h.harvest_date, h.id) from public.harvest_events h
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.get_farm_reports() from public, anon;
grant execute on function public.get_farm_reports() to authenticated;


notify pgrst,'reload schema';
commit;
