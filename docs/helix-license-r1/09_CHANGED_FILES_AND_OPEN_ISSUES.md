# Changed files and open issues

Changed source paths:

- `functions/_shared/portal.js`; `functions/api/portal/v1/status.js`; `functions/api/license/v1/pair/start.js`; `functions/api/license/v1/pair/poll.js`; `functions/api/license/v1/sync.js`; `functions/api/telemetry/v1/deals.js`; `functions/vip/api/[[path]].js` — shared auth/crypto/rate-limit helpers, default-off readiness flags, OTP/sync/telemetry APIs, atomic entitlement/email/release flows.
- `public/vip/index.html`; `public/vip/admin/index.html`; `public/vip/login.html`; `public/vip/login/index.html` — member/admin/login integration; existing menu counts retained.
- `public/vip/helix-ui/` — copied 76 UI kit files plus `css/portal-r1.css`, `js/portal-r1.js`, and `js/portal-r1-loader.js` integration files.
- `supabase/migrations/000_helix_otp_preflight_readonly.sql`; `supabase/migrations/202610110001_helix_otp_telemetry.sql`; `supabase/migrations/999_helix_otp_verify_readonly.sql` — preflight, migration draft, read-only verification.
- `cloudflare/_redirects` — valid subdomain rewrites to existing VIP login/admin/reset paths.
- `PRODUCTION_READY/01_PRODUCTION_PREFLIGHT.sql` through `08_OWNER_ACTIONS.md` — exact production SQL order, Cloudflare setup, smoke test, deployment, rollback, and owner steps.
- `tests/portal-r1-contract.test.mjs` — mocked API and portal contract tests.
- `docs/helix-license-r1/00_BASELINE.md` through `09_CHANGED_FILES_AND_OPEN_ISSUES.md` — baseline, architecture, SQL/API/UI/security/testing/rollout/manual action/change notes.

`public/vip/portal.css`, public landing pages, `performance-worker/`, and MT5 sources were not edited. Generated `cloudflare-dist/` is a local build output and is not a source change.

Implemented locally: UI kit copy and portal integration; static login/member/admin visual changes; member OTP lookup/confirmation UI; admin email queue and no-key entitlement wording; Cloudflare API endpoints for OTP/poll/sync/telemetry; default-off feature flags; shared hashing/rate-limit/signing helpers; transactional schema draft; PostgreSQL 18 disposable validation; production package and owner runbook.

Open before production: compare the live Supabase schema/Auth triggers and live Cloudflare project/repository/branch/domains with this local source; prepare backup; configure production secrets/Auth sender/redirects; run the prepared production SQL after the single final approval; inspect frozen `LIVE_R7_UI_CLICK_FIX` and confirm OTP/signature serialization; perform browser/E2E checks. Feature flags default off. The R7 magic allowlist is intentionally empty and performance stays disabled until verified. Existing public D1 showcase and EA source were not modified.
