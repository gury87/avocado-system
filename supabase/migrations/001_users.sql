-- Phase 1: run before inviting/promoting the first administrator.
begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default '',
  role text not null default 'viewer' check (role in ('admin', 'worker', 'viewer')),
  is_active boolean not null default false,
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, anon;

create function private.farm_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid()) and is_active;
$$;
revoke all on function private.farm_role() from public;
grant execute on function private.farm_role() to authenticated, anon;

create policy profiles_read on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.farm_role()) = 'admin');

create function private.sync_auth_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.profiles (id, email, full_name)
    values (new.id, lower(new.email), left(coalesce(new.raw_user_meta_data->>'full_name', ''), 100));
  else
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_auth_profile() from public;
create trigger farm_profile_created after insert on auth.users
for each row execute function private.sync_auth_profile();
create trigger farm_profile_email after update of email on auth.users
for each row execute function private.sync_auth_profile();

-- Existing Auth accounts receive NO farm access until explicitly enabled.
insert into public.profiles (id, email, full_name)
select id, lower(email), left(coalesce(raw_user_meta_data->>'full_name', ''), 100)
from auth.users where email is not null
on conflict (id) do nothing;

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  entity_id text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
create policy audit_admin_read on public.audit_log for select to authenticated
using ((select private.farm_role()) = 'admin');

create function public.admin_set_profile(target_id uuid, new_role text, new_active boolean, new_name text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare previous public.profiles;
begin
  -- Serialize changes to prevent concurrent demotions from removing every admin.
  perform pg_advisory_xact_lock(84123, 1);
  if private.farm_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if new_role is null or new_role not in ('admin', 'worker', 'viewer') or new_active is null then
    raise exception 'INVALID_ROLE';
  end if;
  if new_name is not null and (length(trim(new_name)) < 1 or length(new_name) > 100) then
    raise exception 'INVALID_NAME';
  end if;
  select * into previous from public.profiles where id = target_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if previous.role = 'admin' and previous.is_active and (new_role <> 'admin' or not new_active)
    and not exists (select 1 from public.profiles where role = 'admin' and is_active and id <> target_id) then
    raise exception 'LAST_ADMIN';
  end if;
  update public.profiles set role = new_role, is_active = new_active,
    full_name = coalesce(trim(new_name), full_name),
    invited_by = coalesce(invited_by, auth.uid()) where id = target_id;
  insert into public.audit_log (actor_id, action, entity_id, details)
  values (auth.uid(), 'profile_updated', target_id::text,
    jsonb_build_object('old_role', previous.role, 'new_role', new_role, 'active', new_active));
end;
$$;
revoke all on function public.admin_set_profile(uuid, text, boolean, text) from public, anon;
grant execute on function public.admin_set_profile(uuid, text, boolean, text) to authenticated;

create function public.update_my_profile(new_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.farm_role() is null then raise exception 'FORBIDDEN'; end if;
  if new_name is null or length(trim(new_name)) < 1 or length(new_name) > 100 then raise exception 'INVALID_NAME'; end if;
  update public.profiles set full_name = trim(new_name), joined_at = coalesce(joined_at, now())
  where id = auth.uid();
end;
$$;
revoke all on function public.update_my_profile(text) from public, anon;
grant execute on function public.update_my_profile(text) to authenticated;

commit;
