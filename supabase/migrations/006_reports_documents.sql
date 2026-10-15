-- Run once after migrations 001–005. Uses Supabase Storage.
begin;
create function public.get_farm_reports() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  result := public.get_receipt_workspace();
  return result || jsonb_build_object('shipments', coalesce((
    select jsonb_agg(jsonb_build_object('id', h.id::text, 'harvest_date', h.harvest_date,
      'trader_id', h.trader_id::text, 'variety_id', h.variety_id::text, 'plot_id', h.plot_id::text,
      'containers', h.containers, 'picking_cost', h.picking_cost)
      order by h.harvest_date, h.id) from public.harvest_events h
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.get_farm_reports() from public, anon;
grant execute on function public.get_farm_reports() to authenticated;

do $$
declare id_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into id_type from pg_attribute a
    where a.attrelid = 'public.harvest_events'::regclass and a.attname = 'id' and not a.attisdropped;
  execute format('create table public.farm_documents (
    id uuid primary key default gen_random_uuid(),
    receipt_id uuid references public.farm_receipts(id) on delete restrict,
    shipment_id %s references public.harvest_events(id) on delete restrict,
    storage_path text not null unique,
    file_name text not null check (length(file_name) between 1 and 255),
    mime_type text not null check (mime_type in (''application/pdf'', ''image/jpeg'', ''image/png'', ''image/webp'')),
    file_size integer not null check (file_size between 1 and 10485760),
    created_at timestamptz not null default now(),
    check ((receipt_id is null) <> (shipment_id is null))
  )', id_type);
end;
$$;
create index farm_documents_receipt on public.farm_documents(receipt_id);
create index farm_documents_shipment on public.farm_documents(shipment_id);
alter table public.farm_documents enable row level security;
revoke all on public.farm_documents from anon, authenticated;
grant select, insert, delete on public.farm_documents to authenticated;
create policy documents_admin on public.farm_documents for all to authenticated
  using ((select private.farm_role()) = 'admin') with check ((select private.farm_role()) = 'admin');
create function private.audit_farm_document() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log(actor_id, action, entity_id, details)
      values (auth.uid(), 'document_added', new.id::text, to_jsonb(new));
    return new;
  end if;
  insert into public.audit_log(actor_id, action, entity_id, details)
    values (auth.uid(), 'document_deleted', old.id::text, to_jsonb(old));
  return old;
end;
$$;
revoke all on function private.audit_farm_document() from public, anon, authenticated;
create trigger document_audit after insert or delete on public.farm_documents
  for each row execute function private.audit_farm_document();

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('farm-documents', 'farm-documents', false, 10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']);
create policy farm_documents_read on storage.objects for select to authenticated
  using (bucket_id = 'farm-documents' and (select private.farm_role()) = 'admin');
create policy farm_documents_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'farm-documents' and (select private.farm_role()) = 'admin');
create policy farm_documents_remove on storage.objects for delete to authenticated
  using (bucket_id = 'farm-documents' and (select private.farm_role()) = 'admin');

-- Deleting a linked receipt/shipment requires removing its documents first.
-- RESTRICT keeps files attached to a valid record until that explicit action.
notify pgrst, 'reload schema';
commit;
