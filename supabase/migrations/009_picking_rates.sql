-- Run once after 008. Preserves historical totals, including unknown costs.
begin;
alter table public.farm_settings
  add column picking_rate_small numeric not null default 130 check(picking_rate_small between 0 and 1000000),
  add column picking_rate_large numeric not null default 150 check(picking_rate_large between 0 and 1000000);
alter table public.harvest_events add column picking_rate numeric;
update public.harvest_events set picking_rate = picking_cost / containers
where containers > 0 and picking_cost >= 0 and picking_cost <> 'NaN'::numeric;
alter table public.harvest_events add constraint harvest_picking_rate_valid check(picking_rate is null or picking_rate between 0 and 1000000);

create function private.snapshot_picking_rate() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(84123,2);
  if new.container_size is null or new.container_size not in ('קטן','גדול') then raise exception 'INVALID_CONTAINER_SIZE'; end if;
  select case when new.container_size='גדול' then picking_rate_large else picking_rate_small end
    into new.picking_rate from public.farm_settings where id;
  new.picking_cost := round(new.containers * new.picking_rate,2);
  return new;
end;
$$;
revoke all on function private.snapshot_picking_rate() from public,anon,authenticated;
create trigger harvest_snapshot_picking before insert on public.harvest_events for each row execute function private.snapshot_picking_rate();

create function public.admin_save_farm_settings_with_picking(expected_version integer,new_overdue_days integer,
 new_loss_warning_percent numeric,new_picking_rate_small numeric,new_picking_rate_large numeric)
returns void language plpgsql security definer set search_path='' as $$
declare previous public.farm_settings;
begin
  perform pg_advisory_xact_lock(84123,2);
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if new_picking_rate_small is null or new_picking_rate_small not between 0 and 1000000
    or new_picking_rate_large is null or new_picking_rate_large not between 0 and 1000000
    or new_picking_rate_small <> round(new_picking_rate_small,2) or new_picking_rate_large <> round(new_picking_rate_large,2)
    then raise exception 'INVALID_SETTINGS'; end if;
  select * into previous from public.farm_settings where id for update;
  perform public.admin_save_farm_settings(expected_version,new_overdue_days,new_loss_warning_percent);
  update public.farm_settings set picking_rate_small=new_picking_rate_small,picking_rate_large=new_picking_rate_large where id;
  insert into public.audit_log(actor_id,action,entity_id,details) values(auth.uid(),'picking_defaults_updated','farm',
    jsonb_build_object('before',to_jsonb(previous),'small',new_picking_rate_small,'large',new_picking_rate_large));
end;
$$;
revoke all on function public.admin_save_farm_settings_with_picking(integer,integer,numeric,numeric,numeric) from public,anon;
grant execute on function public.admin_save_farm_settings_with_picking(integer,integer,numeric,numeric,numeric) to authenticated;

create or replace function public.edit_farm_shipment(target_id text, expected_version integer,
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
    or new_containers <> trunc(new_containers) or new_containers > 1000000 then raise exception 'INVALID_SHIPMENT'; end if;
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
  if new_containers < allocated then raise exception 'BELOW_PAID_CONTAINERS'; end if;
  update public.harvest_events set harvest_date = new_date, variety_id = new_variety_id,
    plot_id = new_plot_id, containers = new_containers,
    picking_cost = case when new_containers = previous.containers then previous.picking_cost else round(new_containers * previous.picking_rate, 2) end,
    edit_version = edit_version + 1 where id = previous.id returning * into updated;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), 'shipment_updated', target_id, jsonb_build_object('before', to_jsonb(previous), 'after', to_jsonb(updated)));
  return jsonb_build_object('id', updated.id::text, 'edit_version', updated.edit_version);
end;
$$;
revoke all on function public.edit_farm_shipment(text, integer, date, bigint, bigint, numeric) from public, anon;
grant execute on function public.edit_farm_shipment(text, integer, date, bigint, bigint, numeric) to authenticated;


create function public.edit_farm_shipment_with_picking(target_id text,expected_version integer,new_date date,
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
    update public.harvest_events set picking_rate=new_picking_rate,picking_cost=round(new_containers*new_picking_rate,2)
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
notify pgrst,'reload schema';
commit;
