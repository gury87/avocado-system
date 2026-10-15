-- Run AFTER 001_users.sql and inviting gury87@gmail.com via Supabase Auth.
-- Never exposed as a public RPC. Run only in Supabase SQL Editor as postgres.
do $$
begin
  if not exists (select 1 from public.profiles where email = 'gury87@gmail.com') then
    raise exception 'Invite gury87@gmail.com using Authentication > Users first';
  end if;
  update public.profiles set role = 'admin', is_active = true, full_name = 'מנהל המשק'
  where email = 'gury87@gmail.com';
end;
$$;
