# Owner actions and final approval gate

No production SQL, secret changes, email sends, DNS changes, repository settings, pushes, or deployments were performed. See [09_DIRECT_CLOUDFLARE_GITHUB_VERIFICATION.md](09_DIRECT_CLOUDFLARE_GITHUB_VERIFICATION.md) for direct-access results.

## Remaining access and verification

1. Project `helix-website` is verified: root, www, and VIP domains are Active. Latest production is `3647df6` on `cloudflare-landing`. The live VIP login route works at `/vip/login`; root currently displays the marketing homepage. The local middleware fix maps the VIP host root/shortcuts to the portal, but is not deployed. Do not push yet because `cloudflare-landing` automatically deploys.
2. Confirm the existing Supabase project ref in the dashboard. Back up/record private preflight counts; execute `01_PRODUCTION_PREFLIGHT.sql`, then after explicit final approval execute `02_PRODUCTION_MIGRATION.sql`, then `03_PRODUCTION_VERIFY.sql`. Production SQL has not been run.
3. Confirm the checked-in licensing foundation/schema and `quadriga` product match the actual Supabase project before migration. The isolated PostgreSQL harness does not validate managed Supabase Auth or production schema compatibility.
4. Complete the database behavior matrix in `04_PRODUCTION_SMOKE_TEST.md`, including concurrent activation with one slot remaining. PGlite runtime tests pass the reactivation, session, expiry, ownership, and status cases, but cannot prove concurrent row locking. PostgreSQL 18 is installed/running locally; `psql` cannot authenticate without the local DB password. Open pgAdmin and connect to an isolated local test database with your saved credentials, then tell me it is connected—do not send the password. I can continue the concurrency test there. Production Supabase must not be used as the test database.
5. Only after DB scenario tests, production schema compatibility, and migration/backup readiness, give one explicit approval naming Pages project `helix-website`, branch `cloudflare-landing`, migration `02_PRODUCTION_MIGRATION.sql`, and deployment of the prepared local branch. This push will automatically deploy to production. Nothing from the R1 worktree has been pushed or deployed.

## Safe activation order

1. Deploy with all feature flags false and test login, role routing, Logout, assets, and disabled states.
2. Enable license-management and email-change flags only after their DB/Auth checks pass.
3. Keep OTP off until the separate EA owner verifies `LIVE_R7_UI_CLICK_FIX` protocol and signing compatibility. Keep trading performance off until a real telemetry round-trip and magic allowlist review pass.
4. If a smoke test fails, disable flags and follow `07_ROLLBACK_PLAN.md`; retain additive schema and customer data.
