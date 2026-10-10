-- Run after license-policies.sql. Safe role lookup for browser sessions.
create or replace function public.helix_current_role()
returns text language sql stable security definer set search_path=public as $$
  select coalesce((select role from public.helix_members where id=auth.uid()),'member');
$$;
revoke all on function public.helix_current_role() from public,anon;
grant execute on function public.helix_current_role() to authenticated;
