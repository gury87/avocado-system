-- Phase 2: run only AFTER bootstrap-admin.sql and successful administrator login.
begin;
do $$
begin
  if not exists (select 1 from public.profiles where role = 'admin' and is_active) then
    raise exception 'Create the first active administrator BEFORE securing the farm';
  end if;
end;
$$;

alter table public.harvest_events add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Restrictive membership gate on all current public data tables: old permissive
-- policies cannot leave public access open. Existing RLS policies are retained
-- on tables not currently used by the UI; authenticated access there still needs
-- a suitable permissive policy. Review views/RPCs separately (see setup guide).
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
    and tablename not in ('profiles', 'audit_log') loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('create policy farm_members_only on public.%I as restrictive for all to anon, authenticated using ((select private.farm_role()) is not null) with check ((select private.farm_role()) is not null)', t.tablename);
  end loop;
end;
$$;

-- Replace every harvest policy, since permissive policies combine with OR.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'harvest_events' loop
    execute format('drop policy %I on public.harvest_events', p.policyname);
  end loop;
end;
$$;
revoke all on public.harvest_events from anon, authenticated;
grant select, insert, delete on public.harvest_events to authenticated;
-- Identity/serial insert defaults require sequence usage (not data-table writes).
do $$
declare seq text;
begin
  seq := pg_get_serial_sequence('public.harvest_events', 'id');
  if seq is not null then execute format('grant usage on sequence %s to authenticated', seq); end if;
end;
$$;
create policy harvest_read on public.harvest_events for select to authenticated
using ((select private.farm_role()) is not null);
create policy harvest_insert on public.harvest_events for insert to authenticated
with check ((select private.farm_role()) in ('admin', 'worker') and created_by = (select auth.uid()));
create policy harvest_delete on public.harvest_events for delete to authenticated
using ((select private.farm_role()) = 'admin');

create function private.harvest_actor() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;
revoke all on function private.harvest_actor() from public;
create trigger harvest_set_actor before insert on public.harvest_events
for each row execute function private.harvest_actor();

create function private.audit_harvest() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    insert into public.audit_log (actor_id, action, entity_id, details)
    values (auth.uid(), 'shipment_deleted', old.id::text, to_jsonb(old));
    return old;
  end if;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), 'shipment_created', new.id::text, to_jsonb(new));
  return new;
end;
$$;
revoke all on function private.audit_harvest() from public;
create trigger harvest_audit after insert or delete on public.harvest_events
for each row execute function private.audit_harvest();
commit;
