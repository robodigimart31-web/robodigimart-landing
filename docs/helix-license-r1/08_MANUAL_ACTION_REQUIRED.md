# Manual actions required (owner checklist)

**Nothing in this checklist has been executed. Do not use production for first validation. No password, key, or token should be pasted into chat.**

## 1. Confirm source and prepare staging

1. In Cloudflare, identify which Pages project/repository/branch actually serves `robodigimart.com` and `vipmember.robodigimart.com`. Confirm that the release source here is the deployed source before merging anything. Current mapping is NOT VERIFIED.
2. In Supabase, select/create a STAGING project separate from production. Take and verify a database backup/snapshot first.
3. Open **SQL Editor** for staging and run `supabase/migrations/000_helix_otp_preflight_readonly.sql`. Confirm the existing base tables/types are present and save the result without exporting user emails or secrets.
4. Review `supabase/migrations/202610110001_helix_otp_telemetry.sql` against the staging schema and base policies. Run this migration file only in staging after the preflight matches. It is currently **NOT APPLIED**.
5. Run `supabase/migrations/999_helix_otp_verify_readonly.sql`. Expected: all eight new tables and the RPC functions resolve; `anon_can_execute=false`, `authenticated_can_execute=false`, `service_role_can_execute=true` for service-only RPCs; all new tables show RLS enabled and no direct anon/authenticated privileges. `enabled_verified_magic_count` is expected to be `0` until R7 magic values are reviewed.

If any SQL fails, stop. Copy only the sanitized error text and query position; do not retry modified SQL against production.

## 2. Cloudflare Pages staging settings

In **Workers & Pages → the staging Pages project → Settings → Variables and Secrets**, configure staging values. Mark private values as **Secret**:

- `SUPABASE_URL` — staging project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — staging service-role key (Secret; server-side only).
- `SUPABASE_PUBLISHABLE_KEY` — staging publishable key.
- `PAIRING_HASH_SECRET` — random secret with at least 32 bytes of entropy; Secret.
- `LICENSE_SIGNING_PRIVATE_KEY_PKCS8` — Ed25519 private key encoded as base64 PKCS#8 DER; Secret.
- `PORTAL_PUBLIC_URL` — exact HTTPS staging origin (currently allowed main site/subdomains; update source allowlist if staging uses `pages.dev`).

Generate private material locally/offline and store only in Cloudflare Secrets. Never commit it or send it in chat. For example, with OpenSSL available: `openssl rand -base64 32` for the HMAC secret; `openssl genpkey -algorithm Ed25519 -out helix-ed25519-private.pem`; then `openssl pkcs8 -topk8 -nocrypt -in helix-ed25519-private.pem -outform DER | openssl base64 -A` for the signing secret. Keep the key file protected and use a reviewed key-rotation plan.

The existing browser uses the Supabase publishable key only. Never put a service-role key in `NEXT_PUBLIC_*`, browser HTML/JS, or a non-secret Text variable.

## 3. Supabase Auth email and domain

1. In staging Supabase **Authentication → URL Configuration**, set the staging Site URL and add exact invite/recovery redirects: `<staging-origin>/vip/login?flow=invite` and `<staging-origin>/vip/login?flow=recovery`.
2. Configure a verified sender/custom SMTP in staging if reliable invite/reset delivery is required. Until this is done, Supabase Auth is the sender and may rate-limit invitations. Do not resend repeated invitations while rate-limited.
3. Test invite and reset emails only with an owner-controlled staging address. Confirm activation sets a user password, role redirect opens `/vip/admin/` only for an admin, and logout returns to `/vip/login`.
4. For the custom subdomain, use the Pages project **Custom domains** workflow for `vipmember.robodigimart.com`, follow Cloudflare's DNS validation prompts, wait for active status, then test `/vip/login`, `/vip/`, and `/vip/admin/`. Do not change production DNS until separately approved.

## 4. Final staging tests / evidence to return

Use a test admin and test member. Verify create/assign license, first activation only, wrong/expired OTP, explicit broker/login confirmation, sixth slot rejection, release reason and session revocation, email request/approval/verification, cross-member data denial, empty performance before telemetry, and verified-magic telemetry after the R7 contract is reviewed. Use browser Network/Console and the read-only SQL verification output. Return sanitized PASS/FAIL results and sanitized error text; never include access tokens, pairing codes, private key material, email invitation links, service-role keys, or customer PII.

## 5. Existing secret hygiene

The sibling `helix-website/performance-worker/.dev.vars` was not opened. Treat `PUBLISHER_API_KEY` as potentially exposed and rotate it manually in the appropriate publisher/Worker environment, then update the authorized publisher securely. Do not rotate `ACCOUNT_HASH_SALT` until a plan preserves existing account identities. No secret rotation, email send, migration, DNS change, or deployment was performed in this work.
