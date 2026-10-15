-- Run after 001, 002 and 003. Changes are authorized in the database, not just UI.
begin;
alter table public.harvest_events add column edit_version integer not null default 0;
revoke update on public.harvest_events from anon, authenticated;

create function public.edit_farm_shipment(target_id text, expected_version integer,
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
  if new_date is null or new_variety_id is null or new_variety_id not in (1,2,3,4)
    or new_plot_id is null or new_plot_id not in (1,2,3) or new_containers is null
    or new_containers <= 0 or new_containers = 'NaN'::numeric
    or new_containers <> trunc(new_containers) or new_containers > 1000000 then raise exception 'INVALID_SHIPMENT'; end if;
  select * into previous from public.harvest_events where id::text = target_id for update;
  if not found then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  if previous.edit_version is distinct from expected_version then raise exception 'STALE_SHIPMENT'; end if;
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
    picking_cost = new_containers * case when container_size = 'גדול' then 150 else 130 end,
    edit_version = edit_version + 1 where id = previous.id returning * into updated;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), 'shipment_updated', target_id, jsonb_build_object('before', to_jsonb(previous), 'after', to_jsonb(updated)));
  return jsonb_build_object('id', updated.id::text, 'edit_version', updated.edit_version);
end;
$$;
revoke all on function public.edit_farm_shipment(text, integer, date, bigint, bigint, numeric) from public, anon;
grant execute on function public.edit_farm_shipment(text, integer, date, bigint, bigint, numeric) to authenticated;
notify pgrst, 'reload schema';
commit;
