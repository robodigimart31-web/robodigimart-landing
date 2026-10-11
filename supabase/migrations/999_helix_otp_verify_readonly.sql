-- Read-only post-migration verification. No member PII, tokens, or key hashes returned.
select to_regclass('public.helix_pairing_requests') as pairing_table,
       to_regclass('public.helix_license_sessions') as sessions_table,
       to_regclass('public.helix_email_change_requests') as email_requests_table,
       to_regclass('public.helix_telemetry_deals') as telemetry_deals_table,
       to_regclass('public.helix_completed_trades') as completed_trades_table,
       to_regclass('public.helix_api_rate_limits') as rate_limit_table,
       to_regclass('public.helix_admin_license_requests') as admin_license_requests_table,
       to_regclass('public.helix_telemetry_magic_allowlist') as magic_allowlist_table;

select p.proname as function_name,pg_get_function_identity_arguments(p.oid) as arguments,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('helix_rate_limit','helix_admin_create_license','helix_admin_update_license','helix_pairing_start','helix_pairing_lookup','helix_pairing_approve','helix_pairing_poll','helix_license_sync','helix_release_binding','helix_ingest_telemetry_deals','helix_member_performance_summary')
order by p.proname;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
       has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_has_any_privilege,
       has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as authenticated_has_any_privilege
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('helix_pairing_requests','helix_license_sessions','helix_email_change_requests','helix_telemetry_deals','helix_completed_trades','helix_api_rate_limits','helix_admin_license_requests','helix_telemetry_magic_allowlist')
order by c.relname;

select count(*) as enabled_verified_magic_count from public.helix_telemetry_magic_allowlist where enabled=true and verified_at is not null;
-- Expected before LIVE_R7_UI_CLICK_FIX audit: enabled_verified_magic_count = 0.
