-- Read-only verification for 202610110003_helix_admin_member_performance.sql.
-- Run only after reviewing/applying the migration in the intended environment.
select jsonb_build_object(
  'summary_rpc_exists',to_regprocedure('public.helix_admin_member_performance_summary(uuid)') is not null,
  'anon_can_execute',coalesce(has_function_privilege('anon','public.helix_admin_member_performance_summary(uuid)','EXECUTE'),false),
  'authenticated_can_execute',coalesce(has_function_privilege('authenticated','public.helix_admin_member_performance_summary(uuid)','EXECUTE'),false),
  'service_role_can_execute',coalesce(has_function_privilege('service_role','public.helix_admin_member_performance_summary(uuid)','EXECUTE'),false),
  'rls_enabled',coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='helix_completed_trades'),false),
  'enabled_verified_magic_count',(select count(*) from public.helix_telemetry_magic_allowlist where enabled and verified_at is not null)
) as member_performance_migration_verification;

-- Expected before enabling portal performance flags:
-- summary_rpc_exists = true
-- anon_can_execute = false
-- authenticated_can_execute = false
-- service_role_can_execute = true
-- rls_enabled = true
-- enabled_verified_magic_count remains 0 until EA source and magic ownership are audited.
