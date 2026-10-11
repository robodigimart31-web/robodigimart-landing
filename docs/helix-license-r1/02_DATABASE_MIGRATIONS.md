# Database migration draft

**Status: NOT APPLIED to Supabase.** The exact migration has been applied in a disposable PostgreSQL 18 PGlite harness against the checked-in license foundation, with minimal auth.users/auth.uid and helix_series fixtures. This validates PostgreSQL parsing and major transactional behavior; it is not a substitute for the actual Supabase production schema or managed Auth.

1. `supabase/migrations/000_helix_otp_preflight_readonly.sql` — read-only prerequisites and RLS/type inventory.
2. Existing base schema, `license-schema.sql`, `license-policies.sql`, `auth-trigger.sql`, and `role-rpc.sql` must already be present in the target staging DB. Confirm `helix_series` has the `quadriga` product slug and expected enum definitions.
3. `supabase/migrations/202610110001_helix_otp_telemetry.sql` — additive draft in one transaction.
4. `supabase/migrations/999_helix_otp_verify_readonly.sql` — read-only grants/RLS/function inventory. Do not export PII.

The migration makes `expires_at` nullable for pending first activation without changing legacy values; adds activation metadata; creates pairing/session, email-request, API rate-limit, idempotent license-assignment, telemetry-deal, completed-trade, and magic-allowlist tables; enables RLS and withholds direct table privileges; adds atomic service-role RPCs for license assignment/update, pairing, sync, slot release, rate limits, email approval, telemetry ingestion, and member-scoped summary; and adds Auth email approval/verification triggers. Admin slot reductions and pairing both lock the license row so the configured capacity cannot race past active bindings.

The migration assumes the existing table/column names, `helix_event_type`, `helix_license_status`, `helix_active_slot_count`, `helix_is_admin`, and `quadriga` series row. PGlite validation confirmed it preserves a seeded legacy expiry, creates a 730-day first activation, enforces the five-slot cap and safe capacity reductions, runs approved email verification triggers, protects eight new tables with RLS, and grants fourteen protected RPCs only to service_role. The full production schema.sql and real Supabase Auth implementation are not present in this checkout and remain an owner verification step. No reverse migration is supplied; rollback uses feature flags/application rollback while preserving additive data.
