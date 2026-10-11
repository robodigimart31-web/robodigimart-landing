# Rollback and containment plan

The migration is additive against the checked-in HELIX licensing foundation. It preserves every existing license row and current expires_at value. It relaxes expires_at nullability only to support new first-activation licenses, then adds columns, tables, indexes, functions, policies, and Auth triggers. It does not delete customer rows.

## Contain an incident

1. In Cloudflare Pages → Settings → Variables and Secrets, set PORTAL_LICENSE_MANAGEMENT_ENABLED, PORTAL_EMAIL_CHANGE_ENABLED, PORTAL_OTP_ENABLED, PORTAL_PERFORMANCE_ENABLED and EA_R7_TELEMETRY_READY to false. Verify /api/portal/v1/status reports all disabled.
2. Roll the existing Pages project back to the previous known-good deployment through Workers & Pages → verified project → Deployments → Rollback (or its verified GitHub deployment workflow). Do not create a new project or change DNS as a shortcut.
3. Preserve the migration, deployment ID/time, sanitized errors, and Supabase snapshot for investigation. Do not export customer secrets or raw account data.
4. Leave additive schema in place during diagnosis. Do not DROP production tables, columns, functions, or triggers. Do not apply an ad hoc down migration.
5. If the email guard blocks an unrelated Auth operation, keep email change off and investigate the exact managed Auth flow before changing triggers.
6. Restore deployment and flags only after the failing smoke test passes outside production and a new final approval is given.

Whole-database restore is a last-resort owner/Supabase support operation from a verified backup because it may discard writes after the snapshot. There is no automatic destructive down migration.
