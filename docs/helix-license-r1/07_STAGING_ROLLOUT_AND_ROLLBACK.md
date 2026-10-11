# Staging rollout and rollback

1. Confirm the canonical release branch/project mapping with the site owner; it is currently NOT VERIFIED.
2. Create a disposable Supabase staging project or verified database backup. Run preflight SQL and review the migration assumptions.
3. Apply the migration only to staging, then run read-only verification. If any prerequisite/output differs, stop and review before proceeding.
4. Add the server-only Cloudflare Pages staging secrets/bindings listed in `08_MANUAL_ACTION_REQUIRED.md`. Add the staging URL to Supabase Auth redirect allowlist and configure verified email delivery.
5. Deploy only to an isolated staging Pages branch after explicit owner approval. Test invite -> set password -> role redirect/logout; member/admin permissions; license create; OTP pairing with a test terminal; release; email approval/verification; empty performance; synthetic telemetry and cross-member rejection.
6. Review build output and browser console/network for missing assets, 404s, CORS/CSP issues, and secrets. Do not use production customer accounts.

Rollback: disable/revert the staging Pages deployment first. Preserve the staging DB snapshot and audit data. Restore the snapshot if migration validation failed; do not execute ad-hoc `DROP` statements or reverse schema against a live DB. Production migration/deployment requires a separate explicit approval after staging evidence is reviewed.
