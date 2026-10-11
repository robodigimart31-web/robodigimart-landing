# HELIX QUADRIGA — Production Migration & EA Compatibility Audit Handoff

Date: 2026-10-11 (Asia/Jakarta)
Repository: `robodigimart31-web/robodigimart-landing`
Cloudflare Pages project: `helix-website`
Production branch: `cloudflare-landing`
Latest production commit before the pending member-performance change: `127d1e2`.

## Request for the reviewing ChatGPT

Audit the supplied HELIX portal source, Supabase migrations, Cloudflare Functions, performance Worker, and the actual HELIX EA source together. Do not infer that two telemetry systems are compatible just because both use magic numbers or calculate profit. Trace the exact production request, authentication/session proof, payload fields and types, history time zone, deal/position lifecycle, currency, allowlist checks, database writes, and member/license/account ownership from EA code through the final Admin Portal values.

Identify the one intended end-to-end performance data path and provide a field-by-field contract table for it. Check that total net profit, win rate, and profit factor are computed from the same completed positions, costs, currency, and time range in EA, API, SQL, and UI. Explicitly analyze multi-currency member accounts: do not add values across currencies without a verified conversion rule. Review RLS, service-role boundaries, request size/rate limits, replay/idempotency, historical resync, and production feature-flag order. Return concrete code or migration corrections and test cases. Do not enable production flags, apply production SQL, or deploy without owner approval.

## Current repository / production state

The repository's Pages site is deployed from `cloudflare-landing`; a push to that branch triggers production deployment. The deployed VIP portal exposes Admin and Member shells. Production status was checked at `/api/portal/v1/status`: `license_management=true`, `otp_pairing=false`, `email_change=false`, and `trading_performance=false`. In `wrangler.jsonc`, both `PORTAL_PERFORMANCE_ENABLED` and `EA_R7_TELEMETRY_READY` are false in Production and Preview. Keep both false pending the audit and an end-to-end test.

The owner previously supplied the Supabase production verification result showing the telemetry tables with RLS enabled, browser roles without table privileges, protected telemetry/performance RPCs callable only by `service_role`, and `enabled_verified_magic_count=0`. Therefore no verified magic number is currently enabled for production telemetry. Existing `helix_member_performance_summary(uuid,uuid,uuid,timestamptz,timestamptz,text)` exists and is service-role-only according to that result.

Base licensing/telemetry migration `PRODUCTION_READY/02_PRODUCTION_MIGRATION.sql` was run manually by the owner and its verification output was provided. Do not rerun the base migration blindly. The separately added `supabase/migrations/202610110002_helix_admin_member_roles.sql` may still need owner-side application; its production state has not been verified in this session. The new aggregate migration `supabase/migrations/202610110003_helix_admin_member_performance.sql` is a proposed incremental migration and has not been applied to production.

## Critical architecture finding to verify

There are currently two different telemetry paths in the source:

1. `mt5/HELIX_PERFORMANCE_PUBLISHER_V3.mq5` posts to `https://helix-performance.robo-digimart31.workers.dev/api/publisher/mt5`, authenticating with a static `InpPublisherKey`. It sends a V3 snapshot containing `account_login`, `broker`, `currency`, `history_from`, `broker_now`, `recorded_at_unix`, and deals shaped as `id`, broker-time `time`, numeric `type`/`entry`, `position`, `volume`, `profit`, `commission`, `swap`, `fee`, and `magic`.
2. `performance-worker/worker.mjs` + `performance-worker/metrics.mjs` validate that payload and write one global `live_state` row to a D1 database. The worker locks that row to one hashed broker/account identity; it does not join Supabase member, license, or binding records. `/api/performance` returns the global aggregate. It is not a per-member data store.
3. The portal's per-member metrics path is different: `functions/api/telemetry/v1/deals.js` requires a bearer session proof created by the OTP/license session flow and expects at most 2,000 normalized deals with `deal_ticket`, `position_id`, ISO `occurred_at`, string `direction` (`BUY`/`SELL`), string `entry_kind` (`IN`/`OUT`/`INOUT`), costs, currency, symbol, and magic. It calls Supabase RPC `helix_ingest_telemetry_deals`, which resolves the binding from the session hash, checks the verified magic allowlist, and writes `helix_telemetry_deals` / `helix_completed_trades`. Admin aggregation then reads completed trades across all licenses and bindings belonging to a member.

The V3 publisher payload is not accepted directly by the Supabase endpoint: it uses a different bearer credential, different endpoint, different field names/types, broker-local timestamps without an explicit offset, permits up to 15,000 deals / 3 MB while the Supabase path caps at 2,000 deals / 1.5 MB, and has no member/session binding in its payload. The separate Worker also has one global account slot. The repository's `mt5/` folder contains publisher V2/V3 sources but no full trading EA/OTP client implementation or entitlement signature verifier. This is a likely blocker to per-member live performance and must be reconciled before activating performance.

## Per-member Admin feature in this branch

The Admin **Member** menu now has a panel with net profit, win rate, profit factor, number of linked accounts, closed positions, and last telemetry sync for each member. Net profit and profit factor aggregate completed positions; win rate is wins divided by all completed positions, including break-even positions. The panel uses a new admin-only RPC and an authenticated Admin API endpoint. For mixed-currency histories, it suppresses net profit and profit factor; those monetary values are not comparable without an explicit, audited FX conversion policy. No sample/mock performance values are shown.

The endpoint requires a server-verified admin session and remains gated by both `PORTAL_PERFORMANCE_ENABLED` and `EA_R7_TELEMETRY_READY`. If either flag is false it returns a waiting state without reading telemetry. The browser never calls the privileged RPC directly. `202610110003_helix_admin_member_performance.sql` makes the aggregate RPC callable by `service_role` only and rechecks the actor's admin role. A read-only post-migration ACL/RLS check is in `PRODUCTION_READY/12_MEMBER_PERFORMANCE_VERIFY.sql`.

## Files to inspect together

- EA publishers: `mt5/HELIX_PERFORMANCE_PUBLISHER_V3.mq5`, `mt5/HELIX_PERFORMANCE_PUBLISHER_V2.mq5`
- Separate Worker: `performance-worker/worker.mjs`, `performance-worker/metrics.mjs`, `performance-worker/schema.sql`, `performance-worker/wrangler.jsonc`, `performance-worker/metrics.test.mjs`
- Supabase base migration: `PRODUCTION_READY/02_PRODUCTION_MIGRATION.sql`, `supabase/migrations/202610110001_helix_otp_telemetry.sql`
- Incremental migrations: `supabase/migrations/202610110002_helix_admin_member_roles.sql`, `supabase/migrations/202610110003_helix_admin_member_performance.sql`
- Supabase verification: `PRODUCTION_READY/03_PRODUCTION_VERIFY.sql`, `PRODUCTION_READY/03B_PRODUCTION_VERIFY_SUMMARY.sql`, `supabase/migrations/999_helix_otp_verify_readonly.sql`
- Cloudflare API and status: `functions/api/telemetry/v1/deals.js`, `functions/api/license/v1/pair/start.js`, `functions/api/license/v1/pair/poll.js`, `functions/vip/api/[[path]].js`, `functions/api/portal/v1/status.js`, `wrangler.jsonc`
- Portal metrics UI: `public/vip/admin/index.html`, `public/vip/helix-ui/js/portal-r1.js`
- Runbooks: `PRODUCTION_READY/05_CLOUDFLARE_SETUP.md`, `PRODUCTION_READY/06_DEPLOYMENT_STEPS.md`, `PRODUCTION_READY/07_ROLLBACK_PLAN.md`, `PRODUCTION_READY/10_MEMBER_ROLE_MANAGEMENT.md`

The real trading EA source must also be supplied to the auditor if it is stored outside this repository. Publisher V3 alone is not enough to verify the EA's session acquisition, signing, telemetry schedule, trade ownership rules, or signing-key verification.

## Safe production sequence after review

1. Resolve and test one EA-to-Supabase telemetry contract; verify timestamps, partial closes, netting/hedging behavior, commissions/fees, magic ownership, resync/replay, and per-account currency.
2. Review and apply the incremental migrations only after the owner confirms they are needed: role audit migration `202610110002` and per-member aggregate `202610110003`. Do not rerun the already-applied base migration.
3. Run the read-only checks in `PRODUCTION_READY/12_MEMBER_PERFORMANCE_VERIFY.sql`; verify the aggregate RPC exists and is executable only by `service_role`, RLS is enabled, and the verified-magic count remains intentional. Exercise the query with multiple accounts for one member, no trades, winning-only trades, losses, and mixed currencies in a non-production test environment.
4. Complete a real-account, non-trading telemetry round-trip in the approved environment. Verify the per-member numbers against a hand-calculated closed-position sample.
5. Only then, with owner approval, add verified `magic` values to the allowlist and enable `PORTAL_PERFORMANCE_ENABLED=true` plus `EA_R7_TELEMETRY_READY=true`. Never enable these flags based only on the publisher compiling or the database schema existing.
6. Deploy the reviewed source to the existing Pages project/production branch and run the documented smoke tests. Do not deploy the separate `performance-worker` or change its secrets/bindings as part of this portal deploy unless the audit explicitly requires it.

## Copy-ready request

“Please audit the attached HELIX source files as one production system. Trace `HELIX_PERFORMANCE_PUBLISHER_V3.mq5` through its actual worker/API/database and compare it with the Supabase OTP telemetry pipeline used by the VIP portal. Confirm whether the EA can populate `helix_completed_trades` with the authenticated member/license/account ownership needed by the Admin per-member summary. Give an exact field-by-field mismatch list, including auth token, endpoint, JSON names/types, time zone, batch limits, magic allowlist, closed-position accounting, currency behavior, and signature verification. Review migrations `202610110001`, `202610110002`, and `202610110003` plus the production SQL/verification files. Identify security, data-integrity, migration-order, or production-activation blockers. Recommend one canonical pipeline and give exact patches/tests for it. Keep all production performance flags disabled until an end-to-end test proves correct. Do not assume or invent data not present in the supplied files.”
