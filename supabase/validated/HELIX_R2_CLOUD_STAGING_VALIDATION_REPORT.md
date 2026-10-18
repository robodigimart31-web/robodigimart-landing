# HELIX R2 — Supabase Cloud Staging Validation

Date: 2026-10-18 (UTC); tests executed in Supabase Cloud, not local PostgreSQL.

## Targets and isolation

- **Staging:** `helix-r2-staging`, project ref `tjaqaodpueptuihvccot`, region `ap-northeast-1`, PostgreSQL 17.11, ACTIVE_HEALTHY.
- **Production:** `robodigimart-Helix`, project ref `wouwoefzghecuiknznvs` — **read-only inspection only**, no schema changes, data writes, feature flag changes, or deployment.
- Supabase staging project creation quoted **$0/month**; no production upgrade.
- Staging baseline built from live PostgreSQL metadata: 24 public HELIX tables, 2 enums, 100 table constraints, 20 non-constraint indexes, 43 HELIX functions, 14 public-table RLS policies, 6 HELIX triggers (including relevant auth.users triggers), and function/table access grants. Synthetic `quadriga` catalog seeded; **no production member PII or trade data copied**.
- Staging migration registry contains schema-clone preparation migration records plus `helix_r2_staging_full_multiproduct_slots_retention_trial_p1`. **Do not promote staging preparatory migration records to Production**.

## Full migration execution

- Original `supabase/drafts/20261018_mult_product_slots_retention_draft.sql` **FAILED** on full Cloud Staging execution with `ERROR 42803: subquery uses ungrouped column b.broker_server from outer query` in the legacy account reconciliation `HAVING` subquery.
- The failed transaction rolled back completely, verified by absence of the new registry table after failure.
- One-line correction: in the correlated `HAVING NOT EXISTS` subquery, replace ungrouped `b.broker_server` / `b.account_login` references with their aggregate `MIN(...)` values. Grouped normalization remains unchanged.
- **Corrected complete migration PASS** via Supabase Cloud migration tool on staging, with all new tables and RPCs verified. No changes were made to original Production or R1 Cloudflare Worker/D1.
- Corrected SQL artifact: `HELIX_R2_STAGING_VALIDATED_MIGRATION.sql`.
- Corrected SQL SHA-256: `bcf7d829cecee9bfce135fa30a08fca62dfe082cea5a2b71ba7fb23332af4ae4`.

## Verified staging database checks (synthetic fixtures)

1. New member initial +5 slot grant: PASS; repeat returned idempotent.
2. Admin +5 adjustment to 10: PASS; repeat returned idempotent; changed payload using reused key returned `IDEMPOTENCY_CONFLICT`.
3. Canonical account capacity with 5 available: the first five synthetic v2 OTP approvals PASS; sixth returned `MEMBER_SLOT_LIMIT_REACHED`.
4. Full-account release: returned `PENDING_RELEASE` with `slot_retained=true` and did not free a sixth slot. After v1.8k synthetic clean-orders ACK returned `RELEASED`, the sixth pairing PASS.
5. Cross-member attempt to release another member's account: rejected `NOT_OWNER`.
6. Explicit bundle authorization: products `product_b` and `product_d` granted; `product_b` synthetic pairing PASS; `quadriga` on that bundle license denied `PRODUCT_NOT_ALLOWED`.
7. Numeric version comparison: `1.10 > 1.9` PASS; `1.9c` remains syntactically accepted by the comparator (ordering as defined by the source).
8. Historical retention: older released binding with a completed trade survived the retention purge; trade remained queryable via `helix_member_performance_summary_v2` as one USD win / +25 synthetic P/L.
9. Email change capacity: 5 -> 15 source member; 15 transferred to target; replay idempotent; exact license expiry copied with seconds intact; replay idempotent.
10. Security permissions: new registry and slot event tables have RLS enabled; role `authenticated` lacks direct SELECT; direct execution of sensitive `helix_pairing_approve_universal` and `helix_admin_adjust_member_slots` RPCs by `authenticated` disallowed.
11. Legacy cutover with **existing binding rows**: executed the corrected backfill INSERT and linking UPDATE against a synthetic pre-R2-style binding; the binding was linked to exactly one `unreconciled` canonical registry row with `fingerprint_version=0` — PASS.

## Limits — not asserted as fully verified

- No Cloudflare Pages staging deployment or true HTTP end-to-end login and storage tests; only database-side RPC simulation and local suite results supplied by VS Code (84 PASS / 0 FAIL / 4 SKIP).
- Not a full concurrent load/race test, nor an exact QUADRIGA EA binary/wire verifier execution. No MT5/VPS access attempted.
- Staging baseline reproduces the live **effective HELIX schema and functions** via metadata extraction, not a physical/restored clone of all Production rows or extensions; existing Production accounts were represented with synthetic fixtures.
- Production is still on its eight historical migration registry entries. Do not replay duplicate local `202610120001` entries, unregistered Email Change `202610170001`, or staging preparation migrations onto Production.
- Release code is still in a dirty VS Code worktree, without a clean immutable R2 commit; source patch must be integrated there.
- A verified Production data backup / restore path is still required before changing live licensing tables/functions on Supabase Free. Neither Cloudflare Pages deployment nor Production R2 feature activation is authorized by the staging test.
- Independent per-product trading performance attribution remains disabled where product/magic cannot reliably be separated.

## Minimal next action

1. Replace the single draft SQL with the validated artifact in the repository; run the existing tests/build and create a clean R2 release commit with its SQL hash.
2. Obtain/verify a recoverable Production backup/export and short final schema/registry preflight. Do not create missing migration history entries ad hoc.
3. Ask for **one explicit Production GO** for the exact SHA/commit, then apply the tested migration to Supabase Production, deploy Cloudflare Pages, and perform limited license/portal smoke checks with R2 flags OFF until controlled activation.

**Result:** **DB migration and listed synthetic SQL/RPC checks PASS on Cloud Staging.** This is *not* evidence that Cloudflare Pages R2 or full Production is live; pending release-commit/recovery/HTTP integration evidence remains separate.
