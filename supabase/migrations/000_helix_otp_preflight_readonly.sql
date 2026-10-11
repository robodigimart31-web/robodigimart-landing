-- Read-only checklist. Run against STAGING first; this file changes no data/schema.
select current_database() as database_name, current_user as query_role, now() as checked_at;

select table_name
from information_schema.tables
where table_schema='public' and table_name in (
  'helix_members','helix_series','helix_licenses','helix_license_bindings','helix_license_events',
  'helix_announcements','helix_materials'
)
order by table_name;

select column_name,is_nullable,data_type
from information_schema.columns
where table_schema='public' and table_name='helix_licenses'
  and column_name in ('member_id','product_slug','license_key_hash','license_key_hint','status','expires_at','max_accounts','entitlement_version')
order by ordinal_position;

select t.typname as enum_name,e.enumlabel as enum_value
from pg_type t join pg_enum e on e.enumtypid=t.oid
where t.typnamespace='public'::regnamespace and t.typname in ('helix_license_status','helix_event_type')
order by t.typname,e.enumsortorder;

select c.relname as table_name,c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('helix_members','helix_licenses','helix_license_bindings','helix_license_events')
order by c.relname;

-- Do not export auth.users emails, license hashes, API keys, or account logins.
