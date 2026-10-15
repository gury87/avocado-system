-- Run once after migrations 001–004.
begin;
create function public.delete_farm_receipt(receipt_id uuid, expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  previous public.farm_receipts;
  snapshot jsonb;
begin
  perform pg_advisory_xact_lock(84123, 2);
  if coalesce(private.farm_role(), '') <> 'admin' then raise exception 'FORBIDDEN'; end if;
  select * into previous from public.farm_receipts r where r.id = receipt_id for update;
  if not found or previous.version is distinct from expected_version then raise exception 'STALE_RECEIPT'; end if;
  if previous.status not in ('draft', 'cancelled') then raise exception 'CANNOT_DELETE_CONFIRMED'; end if;
  select to_jsonb(previous) || jsonb_build_object('lines', coalesce(jsonb_agg(
    to_jsonb(l) || jsonb_build_object('allocations', (
      select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
      from public.farm_receipt_allocations a where a.line_id = l.id
    ))), '[]'::jsonb)) into snapshot
  from public.farm_receipt_lines l where l.receipt_id = previous.id;
  insert into public.audit_log(actor_id, action, entity_id, details)
    values (auth.uid(), 'receipt_deleted', previous.id::text, jsonb_build_object('before', snapshot));
  delete from public.farm_receipts r where r.id = previous.id;
end;
$$;
revoke all on function public.delete_farm_receipt(uuid, integer) from public, anon;
grant execute on function public.delete_farm_receipt(uuid, integer) to authenticated;
notify pgrst, 'reload schema';
commit;
