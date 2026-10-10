-- Run after license-schema.sql.
-- These policies are intentionally read-only for members. Mutations stay in server APIs.

create or replace function public.helix_is_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.helix_members where id=auth.uid() and role='admin');
$$;
revoke all on function public.helix_is_admin() from public,anon;
grant execute on function public.helix_is_admin() to authenticated;

drop policy if exists member_read_self on public.helix_members;
create policy member_read_self on public.helix_members for select to authenticated
  using (id=auth.uid() or public.helix_is_admin());

drop policy if exists member_read_own_licenses on public.helix_licenses;
create policy member_read_own_licenses on public.helix_licenses for select to authenticated
  using (member_id=auth.uid() or public.helix_is_admin());

drop policy if exists member_read_own_bindings on public.helix_license_bindings;
create policy member_read_own_bindings on public.helix_license_bindings for select to authenticated
  using (exists(select 1 from public.helix_licenses l where l.id=license_id and (l.member_id=auth.uid() or public.helix_is_admin())));

drop policy if exists member_read_own_events on public.helix_license_events;
create policy member_read_own_events on public.helix_license_events for select to authenticated
  using (exists(select 1 from public.helix_licenses l where l.id=license_id and (l.member_id=auth.uid() or public.helix_is_admin())));

drop policy if exists member_read_published_announcements on public.helix_announcements;
create policy member_read_published_announcements on public.helix_announcements for select to authenticated
  using (published=true or public.helix_is_admin());

drop policy if exists member_read_published_materials on public.helix_materials;
create policy member_read_published_materials on public.helix_materials for select to authenticated
  using (published=true or public.helix_is_admin());

-- Admin console policies. The role check is evaluated from helix_members, never from browser input.
drop policy if exists admin_manage_members on public.helix_members;
create policy admin_manage_members on public.helix_members for all to authenticated
  using (public.helix_is_admin()) with check (public.helix_is_admin());
drop policy if exists admin_manage_licenses on public.helix_licenses;
create policy admin_manage_licenses on public.helix_licenses for all to authenticated
  using (public.helix_is_admin()) with check (public.helix_is_admin());
drop policy if exists admin_manage_bindings on public.helix_license_bindings;
create policy admin_manage_bindings on public.helix_license_bindings for all to authenticated
  using (public.helix_is_admin()) with check (public.helix_is_admin());
drop policy if exists admin_manage_events on public.helix_license_events;
create policy admin_manage_events on public.helix_license_events for all to authenticated
  using (public.helix_is_admin()) with check (public.helix_is_admin());
drop policy if exists admin_manage_announcements on public.helix_announcements;
create policy admin_manage_announcements on public.helix_announcements for all to authenticated
  using (public.helix_is_admin()) with check (public.helix_is_admin());
drop policy if exists admin_manage_materials on public.helix_materials;
create policy admin_manage_materials on public.helix_materials for all to authenticated
  using (public.helix_is_admin()) with check (public.helix_is_admin());
