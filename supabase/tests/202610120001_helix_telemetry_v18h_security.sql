select json_build_object(
  'invalid_session_ingest', public.helix_ingest_telemetry_deals_v2(
    repeat('0',64), 681000,
    '[{"deal_ticket":"1","position_id":"1","occurred_at_broker":"2026-10-12T00:00:00","direction":"BUY","entry_kind":"IN","volume":0.1,"profit":0,"commission":0,"swap":0,"fee":0,"currency":"USD","symbol":"EURUSD","magic":681001}]'::jsonb,
    false
  ),
  'unknown_session_magic_update', public.helix_session_set_magic_base(repeat('0',64),681000),
  'anon_can_execute_ingest', has_function_privilege('anon','public.helix_ingest_telemetry_deals_v2(text,bigint,jsonb,boolean)','EXECUTE'),
  'authenticated_can_execute_ingest', has_function_privilege('authenticated','public.helix_ingest_telemetry_deals_v2(text,bigint,jsonb,boolean)','EXECUTE'),
  'service_role_can_execute_ingest', has_function_privilege('service_role','public.helix_ingest_telemetry_deals_v2(text,bigint,jsonb,boolean)','EXECUTE'),
  'canary_only_demo', (select count(*)=1 and bool_and(b.mode='demo' and c.expires_at>now()) from public.helix_telemetry_canary_allowlist c join public.helix_license_bindings b on b.id=c.binding_id),
  'ledger_deal_count', (select count(*) from public.helix_telemetry_deals),
  'completed_trade_count', (select count(*) from public.helix_completed_trades)
)::text as security_checks;
