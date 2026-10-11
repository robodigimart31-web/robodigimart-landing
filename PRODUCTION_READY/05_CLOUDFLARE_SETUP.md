# Cloudflare production setup

## Verify the existing target

Checked-in wrangler.jsonc names the Pages configuration helix-website and writes to cloudflare-dist/. The local Git origin is robodigimart31-web/robodigimart-landing and the working branch is codex/helix-portal-ui-otp-r1. cloudflare/_redirects maps vipmember.robodigimart.com paths to the existing /vip/ portal. This repo does not contain an authenticated Cloudflare account/project binding or production deployment workflow. The live Pages project, whether it is connected to this GitHub repository, production branch, and custom-domain assignments are UNVERIFIED.

Open Cloudflare Dashboard → Workers & Pages → existing project serving robodigimart.com → Settings → Builds & deployments / Custom domains. Confirm repository, branch, build/output, and both domains before proceeding. Stop if it differs from this checkout. Do not create another project/domain.

## Pages production variables and secrets

Open Workers & Pages → verified existing Pages project → Settings → Variables and Secrets → Production. Add these only after the production migration is verified:

| Name | Type | Value / handling |
|---|---|---|
| SUPABASE_URL | Text | Exact Supabase project URL; backend uses this override. |
| SUPABASE_PUBLISHABLE_KEY | Text | Supabase publishable key. Public identifier, not service-role credential. |
| SUPABASE_SERVICE_ROLE_KEY | Secret | Server-side only. Never put in NEXT_PUBLIC_* or browser code. |
| PAIRING_HASH_SECRET | Secret | Random value with at least 32 bytes of entropy. |
| LICENSE_SIGNING_PRIVATE_KEY_PKCS8 | Secret | Ed25519 private key as base64 PKCS#8 DER; must match EA verifier. |
| PORTAL_PUBLIC_URL | Text | https://vipmember.robodigimart.com after domain verification. |
| PORTAL_LICENSE_MANAGEMENT_ENABLED | Text | false initially; true only after migration verification. |
| PORTAL_EMAIL_CHANGE_ENABLED | Text | false initially; true only after Auth triggers/email redirects pass. |
| PORTAL_OTP_ENABLED | Text | false until frozen EA protocol and signature serialization are verified. |
| PORTAL_PERFORMANCE_ENABLED | Text | false until telemetry is verified end-to-end. |
| EA_R7_TELEMETRY_READY | Text | false until frozen R7 payload and magic allowlist are reviewed. |

Feature values must be lowercase true/false. The existing login uses the browser publishable key and should remain working.

Cloudflare Pages Functions live under root functions/. Confirm the Pages project builds that directory. Local build command is npm run build:cloudflare and output is cloudflare-dist. The current GitHub Actions workflow checks builds; it does not deploy production. Use the existing project's verified deployment process only after final approval.

## Supabase Auth URLs

In Supabase Dashboard → Authentication → URL Configuration, set the intended Site URL and allow:
- https://vipmember.robodigimart.com/vip/login?flow=invite
- https://vipmember.robodigimart.com/vip/login?flow=recovery
- https://vipmember.robodigimart.com/vip/login?flow=email-change

Keep existing main-domain routes during transition. Configure a verified SMTP/sender before production invitations or recovery messages.
