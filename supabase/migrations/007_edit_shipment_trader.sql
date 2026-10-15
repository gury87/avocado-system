-- Run once after migrations 001–006. The main shipment entry form is unchanged.
begin;
create function public.get_shipment_traders() returns table(id text, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(private.farm_role(), '') not in ('admin', 'worker') then raise exception 'FORBIDDEN'; end if;
  return query select t.id::text, case when t.id::text = '1' then 'ראובן יהודה'
    else coalesce(nullif(to_jsonb(t)->>'name', ''), nullif(to_jsonb(t)->>'trader_name', ''), 'סוחר ' || t.id::text) end
    from public.traders t order by t.id;
end;
$$;
revoke all on function public.get_shipment_traders() from public, anon;
grant execute on function public.get_shipment_traders() to authenticated;

create function public.edit_farm_shipment_with_trader(target_id text, expected_version integer,
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
  select * into trader from public.traders t where t.id::text = new_trader_id for key share;
  if not found then raise exception 'INVALID_TRADER'; end if;
  if previous.trader_id is distinct from trader.id and exists (
    select 1 from public.farm_receipt_allocations a join public.farm_receipt_lines l on l.id = a.line_id
    join public.farm_receipts r on r.id = l.receipt_id
    where a.harvest_event_id = previous.id and r.status <> 'cancelled'
  ) then raise exception 'LINKED_TRADER'; end if;
  -- Reuse all existing quantity, variety, authorization and concurrency checks.
  result := public.edit_farm_shipment(target_id, expected_version, new_date, new_variety_id, new_plot_id, new_containers);
  if previous.trader_id is distinct from trader.id then
    update public.harvest_events set trader_id = trader.id where id = previous.id returning * into updated;
    insert into public.audit_log(actor_id, action, entity_id, details)
      values (auth.uid(), 'shipment_trader_updated', target_id, jsonb_build_object('before', to_jsonb(previous), 'after', to_jsonb(updated)));
  end if;
  return result;
end;
$$;
revoke all on function public.edit_farm_shipment_with_trader(text, integer, date, bigint, bigint, numeric, text) from public, anon;
grant execute on function public.edit_farm_shipment_with_trader(text, integer, date, bigint, bigint, numeric, text) to authenticated;
notify pgrst, 'reload schema';
commit;
