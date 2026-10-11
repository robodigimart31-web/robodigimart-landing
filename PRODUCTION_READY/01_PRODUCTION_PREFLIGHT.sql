-- READ ONLY. Run only against the confirmed production project after final approval.
begin read only;

do $$
begin
  if to_regclass('public.helix_members') is null
     or to_regclass('public.helix_series') is null
     or to_regclass('public.helix_licenses') is null
     or to_regclass('public.helix_license_bindings') is null
     or to_regclass('public.helix_license_events') is null
     or to_regclass('auth.users') is null then
    raise exception 'PREFLIGHT_FAILED: existing HELIX/Auth base tables are missing';
  end if;
  if not exists(select 1 from pg_type where typname='helix_license_status' and typnamespace='public'::regnamespace)
     or not exists(select 1 from pg_type where typname='helix_event_type' and typnamespace='public'::regnamespace) then
    raise exception 'PREFLIGHT_FAILED: HELIX license/event enum is missing';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='helix_licenses' and column_name='expires_at')
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='helix_licenses' and column_name='license_key_hash')
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='helix_licenses' and column_name='member_id')
     or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='helix_licenses' and column_name='max_accounts') then
    raise exception 'PREFLIGHT_FAILED: expected helix_licenses columns are missing';
  end if;
  if to_regprocedure('public.helix_is_admin()') is null then
    raise exception 'PREFLIGHT_FAILED: expected HELIX admin authorization function is missing';
  end if;
end $$;

select current_database() as database_name, current_user as query_role, now() as checked_at;
select count(*) as existing_member_count from public.helix_members;
select count(*) as existing_license_count,
       count(*) filter(where expires_at is null) as existing_null_expiry_count,
       count(*) filter(where expires_at is not null) as existing_fixed_expiry_count
from public.helix_licenses;
select count(*) as existing_binding_count from public.helix_license_bindings;
select count(*) as existing_license_event_count from public.helix_license_events;
select t.table_name, c.relrowsecurity as rls_enabled
from information_schema.tables t
join pg_class c on c.relname=t.table_name
join pg_namespace n on n.oid=c.relnamespace and n.nspname=t.table_schema
where t.table_schema='public'
  and t.table_name in ('helix_members','helix_licenses','helix_license_bindings','helix_license_events')
order by t.table_name;

rollback;
