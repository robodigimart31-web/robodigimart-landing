# HELIX QUADRIGA ? Production and EA Compatibility Audit Handoff

Date: 2026-10-11 (Asia/Jakarta)
Repository: `robodigimart31-web/robodigimart-landing`
Cloudflare Pages project: `helix-website`
Production branch: `cloudflare-landing`

## Purpose for the reviewing ChatGPT

Audit the supplied HELIX portal source, Supabase migrations, Cloudflare Functions, performance Worker, and the actual HELIX EA source together. Do not infer that two telemetry systems are compatible because both calculate profit. Trace the production request, authentication/session proof, payload fields and types, timestamps/time zone, deal/position lifecycle, currency, magic allowlist, database writes, and member/license/account ownership from EA to the final Admin Portal values.

Identify one intended end-to-end performance data path. Provide a field-by-field contract table and check that net profit, win rate, and profit factor use the same closed positions, fees, currency, and date range across EA, API, database function, and UI. Analyze weekly/monthly growth periods, multi-currency accounts, RLS, service-role boundaries, size/rate limits, replay/idempotency, resync, and feature-flag rollout. Return concrete fixes and test cases. Do not apply production SQL or turn on performance flags during this audit.

## Current production state

The Pages site deploys from `cloudflare-landing`. Production status at `/api/portal/v1/status` reports `license_management=true`, `otp_pairing=false`, `email_change=false`, and `trading_performance=false`. In `wrangler.jsonc`, `PORTAL_PERFORMANCE_ENABLED` and `EA_R7_TELEMETRY_READY` are both false in Production and Preview. Keep them disabled until the EA contract and an end-to-end telemetry test are verified.

The owner supplied Supabase verification showing telemetry tables with RLS enabled, anon/authenticated table access denied, protected functions service-role-only, and `enabled_verified_magic_count=0`. The output also showed the existing function `helix_member_performance_summary(uuid,uuid,uuid,timestamptz,timestamptz,text)` exists and is service-role-only. Base migration `PRODUCTION_READY/02_PRODUCTION_MIGRATION.sql` was manually run by the owner. The production state of incremental role migration `supabase/migrations/202610110002_helix_admin_member_roles.sql` was not verified here.

A first implementation incorrectly called a new `helix_admin_member_performance_summary(uuid)` RPC that was not present in production. That dependency has been removed. The Admin Performance menu now uses the existing `helix_member_performance_summary(...)` RPC per member and period from the authenticated server-side Admin API; no new performance database function or migration is required for that menu. Do not apply the deleted draft migration from earlier Git history.

## Existing performance data paths and likely blocker

1. `mt5/HELIX_PERFORMANCE_PUBLISHER_V3.mq5` sends to `https://helix-performance.robo-digimart31.workers.dev/api/publisher/mt5`, authenticating with a static `InpPublisherKey`. Its snapshot includes `account_login`, `broker`, `currency`, `history_from`, `broker_now`, `recorded_at_unix`, and deals with `id`, broker-time `time`, numeric `type`/`entry`, `position`, `volume`, `profit`, `commission`, `swap`, `fee`, and `magic`.
2. `performance-worker/worker.mjs` and `performance-worker/metrics.mjs` store a single global `live_state` row in D1, locked to one hashed broker/account identity. It does not join Supabase member, license, or binding records. `/api/performance` therefore is not a per-member data source.
3. The VIP portal's database path is `functions/api/telemetry/v1/deals.js` to `helix_ingest_telemetry_deals` and `helix_completed_trades`. It requires a bearer session proof from the OTP/license flow and normalized deals (`deal_ticket`, `position_id`, ISO `occurred_at`, string `direction`, string `entry_kind`, costs, currency, symbol, and magic). `helix_member_performance_summary(...)` reads completed trades for a member, optionally filtered by license, binding, and `p_from`/`p_to`.

Publisher V3 is not directly accepted by the Supabase telemetry endpoint: credentials, URL, field names/types, broker-local timestamps, batch limits (15,000/3 MB versus 2,000/1.5 MB), and ownership proof differ. The standalone Worker has one global account slot. The repo `mt5/` folder contains publisher V2/V3 sources, not the full trading EA/OTP client or entitlement signature verifier. This likely prevents trustworthy per-member values until reconciled.

## Admin Performance menu behavior

The dedicated Admin `Performance` menu lists members with lifetime net profit, win rate, and profit factor, plus weekly and monthly net-profit growth compared with the immediately preceding week/month. The week is selected by its Monday start date in Asia/Jakarta; the month uses a month selector. Each value is sourced from the existing `helix_member_performance_summary(...)` RPC, called for the member and date window. The summary RPC reports `MIXED_CURRENCY`; the UI must not combine different currencies or invent FX conversion. Growth is undefined when the compared periods have different currencies or there is no non-zero comparison basis.

The API authenticates the Supabase user and verifies Admin role before returning the member list or invoking the RPC. It uses the service-role secret server-side; the browser never calls privileged RPCs. If either production performance flag is off, the endpoint returns the live member list with a waiting status and does not query telemetry.

## Files to inspect together

- EA publishers: `mt5/HELIX_PERFORMANCE_PUBLISHER_V3.mq5`, `mt5/HELIX_PERFORMANCE_PUBLISHER_V2.mq5`
- Separate Worker: `performance-worker/worker.mjs`, `performance-worker/metrics.mjs`, `performance-worker/schema.sql`, `performance-worker/wrangler.jsonc`, `performance-worker/metrics.test.mjs`
- Supabase base migration and verification: `PRODUCTION_READY/02_PRODUCTION_MIGRATION.sql`, `PRODUCTION_READY/03_PRODUCTION_VERIFY.sql`, `PRODUCTION_READY/03B_PRODUCTION_VERIFY_SUMMARY.sql`, `supabase/migrations/202610110001_helix_otp_telemetry.sql`, `supabase/migrations/999_helix_otp_verify_readonly.sql`
- Role management: `supabase/migrations/202610110002_helix_admin_member_roles.sql`, `PRODUCTION_READY/10_MEMBER_ROLE_MANAGEMENT.md`
- Cloudflare API: `functions/api/telemetry/v1/deals.js`, `functions/api/license/v1/pair/start.js`, `functions/api/license/v1/pair/poll.js`, `functions/vip/api/[[path]].js`, `functions/api/portal/v1/status.js`, `wrangler.jsonc`
- Portal UI: `public/vip/admin/index.html`, `public/vip/index.html`, `public/vip/helix-ui/js/portal-r1.js`
- Deployment runbooks: `PRODUCTION_READY/05_CLOUDFLARE_SETUP.md`, `PRODUCTION_READY/06_DEPLOYMENT_STEPS.md`, `PRODUCTION_READY/07_ROLLBACK_PLAN.md`

The actual trading EA source must also be supplied if it is stored outside this repository. Publisher V3 alone is not enough to verify the EA session acquisition, signing, telemetry schedule, trade ownership, or signature verification.

## Safe production rollout after audit

1. Reconcile and test one EA-to-Supabase telemetry contract, including timezone, partial closes, netting/hedging, costs, magic ownership, resync/replay, and currency.
2. Verify base migration objects and ACL with `PRODUCTION_READY/03_PRODUCTION_VERIFY.sql` and the owner-supplied `03B` query result. Review role migration `202610110002` separately if Admin role changes are needed. Do not apply a new performance aggregate migration; the Admin menu uses the existing member summary RPC.
3. In a non-production environment, test multiple accounts per member, no trades, wins/losses/break-even, mixed currencies, weekly/monthly boundaries, growth versus the prior period, and zero-profit baseline behavior. Compare each displayed number with a hand-calculated closed-position sample.
4. Verify a real, non-trading telemetry round trip from the actual EA into `helix_completed_trades` with correct member/license/binding ownership.
5. Only after this succeeds and the owner approves, enable verified magic values and both performance flags. Do not enable either flag based only on a successful build or existing database schema.
6. Deploy reviewed source and run portal smoke tests. Do not deploy or change the separate performance Worker unless the EA audit explicitly requires it.

## Copy-ready request

"Please audit these HELIX source files together with the actual HELIX EA source. Trace `HELIX_PERFORMANCE_PUBLISHER_V3.mq5` through its Worker and compare it with the portal's Supabase OTP telemetry path. Confirm whether the actual EA can write verified, correctly owned positions to `helix_completed_trades` so `helix_member_performance_summary(uuid,uuid,uuid,timestamptz,timestamptz,text)` can return correct member metrics. Give an exact field-by-field mismatch list for authentication, URL, JSON fields/types, timezone, batch limits, magic allowlist, closed-position accounting, currency, and signature verification. Audit the existing migrations/RLS and the Admin API that calls the summary RPC for lifetime, selected week, prior week, selected month, and prior month. Validate weekly/monthly growth calculations and mixed-currency behavior. Identify production blockers and propose exact patches/tests. Keep production performance flags disabled; do not run SQL or change production settings."
