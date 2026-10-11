# Test results

Date: 2026-10-11 (Asia/Jakarta). Environment: local working branch only; Supabase staging credentials/database and Cloudflare deployment are not used.

## Baseline before edits

- `npm run typecheck` â€” PASS.
- `npm run build:cloudflare` â€” PASS.
- `npm run check:cloudflare` â€” PASS (75 files).
- `node --test performance-worker/metrics.test.mjs` â€” PASS (8 tests).
- `npm test --if-present` â€” PASS; no npm test script was configured.

## R1 final local checks

- `npm run typecheck` â€” PASS.
- `node --test performance-worker/metrics.test.mjs` â€” PASS; 8 tests.
- `node --test tests/portal-r1-contract.test.mjs` â€” PASS; 10 tests covering OTP/proof hashing, mocked rate limit, default-off feature flags, no-database disabled behavior, member/admin role enforcement, HTML/UI script syntax, 7/5 menu inventory, assets, and key/hash exposure. Node prints a non-fatal `MODULE_TYPELESS_PACKAGE_JSON` warning because Pages Function files are ES modules while the project intentionally has no package-wide `type: module` flag.
- `npm run build:cloudflare` â€” PASS; Pages static export produced.
- `npm run check:cloudflare` â€” PASS; 151 exported files and existing landing-page/SEO checks.
- Cloudflare export asset check â€” PASS; 76 UI kit files copied, member/admin/login loader paths present, mountain/SVG/CSS files present, and the subdomain root redirect is present.
- Inline JS/module syntax checks â€” PASS for login/member/admin pages, R1 scripts, and Pages Function modules.
- `git diff --check` â€” PASS; only Git's configured LF-to-CRLF working-copy notices were printed.
- PostgreSQL 18 PGlite validation â€” PASS: checked-in license foundation plus R1 migration, preflight/verify SQL, all eight new RLS tables, direct anon/authenticated access revoked, and 14 service-only RPC grants.
- Disposable database behavior â€” PASS: existing license expiry preserved; idempotent creation; 730-day expiry starts on first pairing; session poll; six-slot attempt denied; reducing slots under current use rejected; approved Auth email change completes; verified-magic closed trade rolls up once with fees.
- Feature readiness â€” PASS: all new production features default to disabled; OTP/performance endpoints return truthful disabled states and do not call database when disabled; performance additionally requires explicit EA R7 telemetry readiness.
- Production package â€” PASS: eight required files exist; migration bundle SHA-256 matches the R1 source migration; package SQL 01â†’02â†’03 parsed and executed against the disposable PostgreSQL engine. Database behavior fixtures passed; the browser smoke-test checklist was not run against a live deployment.
- Cloudflare source mapping â€” VERIFIED from owner dashboard: project/repository/branch/build settings, current production SHA, and active domains. See `PRODUCTION_READY/09_DIRECT_CLOUDFLARE_GITHUB_VERIFICATION.md`.

The additional export-path check confirms `/vip/login` and `/vip/reset-password` directory routes are exported, all three portal views load the R1 integration script, 76 UI kit files are present, and `_redirects` is included. The subdomain mappings now route /admin, /login, and /reset-password to existing VIP routes.

**NOT RUN:** Any SQL against Supabase staging or production; managed Supabase Auth/email delivery; Cloudflare account/domain/branch verification; production deployment; live EA OTP round-trip or concurrent real-terminal slot test; signing-key compatibility with frozen `LIVE_R7_UI_CLICK_FIX`; browser visual/viewport QA. The PGlite fixture uses checked-in license foundation plus minimal Supabase Auth and helix_series stubs, so it cannot prove the actual production schema matches. No production database or deployment was accessed.

## R2 targeted follow-up

- PostgreSQL 18 PGlite: checked-in foundation plus revised migration compiled and created the updated `helix_pairing_approve` and `helix_touch_binding` functions â€” PASS. This is isolated in-memory validation with minimal Supabase Auth stubs.
- `node --test tests/portal-r1-contract.test.mjs` â€” PASS; now 12 tests. Regression checks cover SQL released-binding invariants and VIP hostname root/shortcut rewrites.
- Isolated PGlite runtime scenarios — PASS: released binding denied at five active slots; same binding reactivated after a slot is freed; prior session stays revoked; pairing approval is idempotent; legacy helix_touch_binding denies full-cap reactivation and accepts it after capacity opens; expired pairing rejected; cross-member lookup rejected; suspended/revoked/expired licenses return expected errors. Runtime validation also found and fixed the legacy INSERT ordering bug (account_fingerprint and mode were swapped).`r`n- Concurrent activation with exactly one slot remaining — NOT TESTED: PGlite harness is single-connection and cannot demonstrate row-lock behavior under concurrent PostgreSQL sessions. Real Supabase schema/Auth compatibility remains unverified.
- Rebuilt `npm run build:cloudflare` â€” PASS. `npm run check:cloudflare` â€” PASS (151 files). `npm run typecheck` â€” PASS. `node --test performance-worker/metrics.test.mjs` â€” PASS (8 tests).
- Migration source and production package bodies â€” identical; package header documents production intent. No production migration or deployment was run.
- GitHub deployment source â€” VERIFIED through Cloudflare's connected repository/branch/deployment SHA and read-only Git remote refs. GitHub Actions history and branch-protection rules were not checked because `gh` is unavailable.

- Production mapping follow-up: Cloudflare dashboard now verifies project/repo/branch/build settings, latest production SHA `3647df6`, and all three active custom domains. Live `/vip/login` works; the VIP hostname root currently opens the marketing homepage. Local Pages middleware fixes hostname routing and has passing contract/build checks, but remains uncommitted and undeployed. See `PRODUCTION_READY/09_DIRECT_CLOUDFLARE_GITHUB_VERIFICATION.md`.
