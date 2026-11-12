-- Run after 009; safe to rerun. Only confirmed receipts count as payments.
begin;
create or replace function private.protect_paid_shipment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(84123,2);
  if (to_jsonb(new) - array['plot_id','edit_version','updated_at']) is distinct from
     (to_jsonb(old) - array['plot_id','edit_version','updated_at']) and exists (
    select 1 from public.farm_receipt_allocations a
    join public.farm_receipt_lines l on l.id=a.line_id
    join public.farm_receipts r on r.id=l.receipt_id and r.status='confirmed'
    where a.harvest_event_id=old.id
  ) then raise exception 'PAID_SHIPMENT_LOCKED'; end if;
  return new;
end;
$$;
revoke all on function private.protect_paid_shipment() from public,anon,authenticated;
drop trigger if exists harvest_protect_paid on public.harvest_events;
create trigger harvest_protect_paid before update on public.harvest_events
for each row execute function private.protect_paid_shipment();
create or replace function public.get_shipment_edit_state(target_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if coalesce(private.farm_role(),'') not in ('admin','worker') then raise exception 'FORBIDDEN'; end if;
  if not exists(select 1 from public.harvest_events where id::text=target_id) then raise exception 'SHIPMENT_NOT_FOUND'; end if;
  return jsonb_build_object('has_payment',exists(
    select 1 from public.farm_receipt_allocations a
    join public.farm_receipt_lines l on l.id=a.line_id
    join public.farm_receipts r on r.id=l.receipt_id and r.status='confirmed'
    where a.harvest_event_id::text=target_id
  ));
end;
$$;
revoke all on function public.get_shipment_edit_state(text) from public,anon;
grant execute on function public.get_shipment_edit_state(text) to authenticated;
notify pgrst,'reload schema';
commit;
