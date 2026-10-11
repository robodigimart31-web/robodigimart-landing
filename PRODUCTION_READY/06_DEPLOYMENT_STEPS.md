# Production deployment sequence

This is a runbook, not an executed deployment. One final approval must explicitly cover both production migration and Pages deployment.

1. Verify the live Pages project/repository/production branch and custom domains using 05_CLOUDFLARE_SETUP.md. Verify the production Supabase URL matches the existing portal.
2. Take a verified Supabase backup/snapshot. Save aggregate before counts from 01_PRODUCTION_PREFLIGHT.sql.
3. In the verified Supabase project's SQL Editor, run 01_PRODUCTION_PREFLIGHT.sql. Stop on PREFLIGHT_FAILED, missing base objects, or uncertain project identity.
4. Run 02_PRODUCTION_MIGRATION.sql once only, after approval and successful preflight. If it errors, stop and inspect sanitized error; do not retry a partially applied file or edit SQL in production.
5. Run 03_PRODUCTION_VERIFY.sql. Confirm all eight new tables exist with RLS, no anon/authenticated table access, and service-role-only execution on protected RPCs. Verified magic count should be zero pending R7 review.
6. Configure Cloudflare variables/secrets and Supabase Auth redirects/SMTP from 05_CLOUDFLARE_SETUP.md. Keep all feature flags false.
7. Deploy this verified source to the already connected production Pages project by its established mechanism. Test login, roles, logout, asset paths, and disabled/empty states with 04_PRODUCTION_SMOKE_TEST.md.
8. Enable license management and email change only after DB/Auth tests pass. Keep OTP and performance disabled until their readiness conditions pass.
9. Enable OTP only after EA owner verifies LIVE_R7_CLICK_FIX request fields, signature bytes/public-key verifier, and real/demo policy. Enable performance only after R7 telemetry round-trip and reviewed magic allowlist.

No step has been performed. Turn relevant flags off and stop on any unexpected result.
