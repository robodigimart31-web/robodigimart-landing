# HELIX D1 Telemetry — R1 Release Readiness

**This document began as the pre-deployment readiness record.** The approved Production execution results are recorded in the final section below.

## Scope and source

- R1 scope is only the `helix-performance` Worker/D1 and its existing public Landing Page contract. No Supabase, portal, OTP, license, Release ACK, Email Change, or MQ5 changes.
- Release branch `codex/r1-d1-telemetry-release` is based on Production source branch `origin/cloudflare-landing` commit `95a257f65e255e03146675ebd058372c13b0e392`. The R1 source release is recorded in the commit listed below.
- Pre-deployment Worker version was `d002d471-94de-4b9c-ad25-706cc9c90c3e` (created 2026-10-10 08:38:19 UTC). The checked-in Production source has the same Worker baseline as the earlier `c463a7c` source; the candidate is isolated in a separate worktree so unrelated backup changes are not included.

## Production read-only evidence

- D1 target: `helix-performance` / `da6d2ee3-cfba-4d5a-8117-d6e1e9cb9770`, APAC, binding `DB`.
- Live public GET still returns `net_profit=0`, `total_trades=0`, null win rate/profit factor/drawdown, and two curve points, updated `2026-10-18T09:57:37Z`.
- Existing separate historical snapshot is unchanged: `2026-10-10T08:23:23Z`, balance/equity `49,174.80`, cashflow `0`. It is not combined with deal P/L.
- `d1_migrations` exists but is empty. The migration folder contains only `0002_telemetry_deal_ledger.sql`; there is no `0001` to replay. Policy: do not fabricate a registry record or rerun a base migration. The exact Wrangler migration command was tested against an isolated D1 with the same existing `live_state` / `snapshots` schema and empty registry; it applied only `0002` successfully, leaving those existing tables intact.
- Read-only secret-name inspection confirms Production has `ACCOUNT_HASH_SALT` and `PUBLISHER_API_KEY` configured; no values were read.
- Earlier read-only Production Time Travel bookmark (superseded by the fresh pre-migration bookmark in final results): `0000006a-00000004-00005108-84b9d5f5a75fa9e199f0cf6fc44970bc`. No Production restore was attempted.

## Isolated Cloudflare D1 + Worker test

A separate APAC D1 was created and verified as the target: `helix-performance-r1-isolated-20261018` / `f7a299a4-5d76-4f7d-8d9d-f929b73d7606`. It is **not** the Production database. Migration `0002` was applied there after seeding the existing-schema/public-baseline fixture. The rollback trigger was added to the draft afterward; its exact DDL was then applied and exercised separately on this same isolated D1. The complete final migration file, including the trigger, also passes the disposable-SQLite migration/Worker suite.

Results on the actual Worker preview bound to that remote isolated D1:

- Migration registry contains only `0002_telemetry_deal_ledger.sql`; original `live_state` and snapshot row/payload remain intact.
- Baseline mode public response remains exactly 0 net profit / 0 closed trades and reports `legacy_baseline_preserved`.
- Three V3-format publisher syncs stored 4 unique strategy tickets; a later sync with only an already stored ticket kept the count at 4. Candidate is 17 net profit / 2 trades; an MT5 correction-type row with 999,999 profit was excluded.
- Public output did not contain the test login. Invalid publisher authorization returned 401 without writes.
- Concurrent first-publish requests for two different account identities returned one 200 and one 409; D1 held the winning account’s tickets under one salted identity only.
- With coverage explicitly staged in the test database, an accepted Worker candidate changed public state atomically from baseline to ledger output (17 / 2), without adding the baseline aggregate. Legacy-style direct writes to `live_state` were ignored by the DB trigger in both baseline and verified modes.
- Time Travel restore was exercised on this isolated D1: a test marker was reverted while the ledger, candidate, baseline, and historical snapshot remained at the chosen recovery bookmark. No Production restore was run.

The isolated test database is retained separately for inspection. Wrangler local D1 was unavailable on this Windows host (`spawn EFTYPE`); WSL2 is not installed. Using isolated Cloudflare D1 replaced that local-runtime test path.

## Publisher compatibility

Read-only inspection of `mt5/HELIX_PERFORMANCE_PUBLISHER_V3.mq5` confirms it sends the Worker’s accepted V3 schema to the existing endpoint: version/scope, real account, digit login, exact broker/server string, currency/symbol, broker timestamps, Unix timestamp, and deals with ticket `id`, `position`, numeric type/entry/magic, volume, profit, commission, swap, and fee. The Worker’s current auth secret names are present in Production.

That V3-shaped payload was accepted by the Worker preview against Cloudflare D1. No live MT5 terminal/key was used, and MQ5 was not modified; the real terminal’s WebRequest allowlist/key setting can only be confirmed by its next sync.

## Behavior after R1

The migration copies the currently displayed public payload to `telemetry_legacy_baseline` and seeds `telemetry_control` in `legacy_baseline` mode. New syncs begin persisting deduplicated deals and updating a separate candidate immediately. The Landing Page continues showing the preserved 0/0 baseline until coverage is independently attested and publication is deliberately staged. Old baseline and new candidate are never added together. Missing pre-ledger broker history is therefore **not a blocker to starting capture**, but it is not falsely reconstructed or presented as complete.

The additive migration also adds a `live_state` write guard: an old Worker rollback cannot overwrite the saved baseline/candidate. Code rollback keeps the current public payload but intentionally stops old-version publishing until the new Worker is restored. The migration does not alter the existing `snapshots` row.

## Tests

- Candidate `npm run test:performance`: **21 passed, 0 failed** (includes actual migration SQL on disposable SQLite).
- Existing full suite from the prior validation: **77 passed, 0 failed, 1 optional PostgreSQL test skipped**.
- `typecheck`, Cloudflare build/check, and Wrangler bundle dry-run passed before the final rollback guard; final worker suite passes after that guard.
- Cloudflare D1 migration, sync/deduplication/archive behavior, approval transition, rollback guard, concurrent account claim, and Time Travel restore were separately exercised against the isolated remote D1.
- Production was queried only read-only and its public response was unchanged.

## Exact commands — prepared in the pre-deployment record

These commands are retained as the exact release command record; execution results appear in the final section.

```powershell
# Apply only 0002; the isolated test proved an empty existing registry applies this file alone.
npx wrangler d1 migrations apply helix-performance --remote --config performance-worker/wrangler.jsonc

# Deploy only the Landing Page performance Worker.
npx wrangler deploy --config performance-worker/wrangler.jsonc --name helix-performance --message "R1 persistent landing telemetry ledger"
```

## Recovery

- Worker-only rollback (does not change D1):
  ```powershell
  npx wrangler rollback d002d471-94de-4b9c-ad25-706cc9c90c3e --config performance-worker/wrangler.jsonc --name helix-performance --message "Rollback R1 telemetry Worker"
  ```
  The migration’s write guard keeps the existing `live_state` snapshot from being overwritten by that older binary. New ingestion pauses until the new Worker is restored.
- D1 Time Travel restore (last resort; rewinds **all** D1 writes after the bookmark and needs separate explicit approval):
  ```powershell
  npx wrangler d1 time-travel restore helix-performance --config performance-worker/wrangler.jsonc --bookmark 0000006a-00000004-00005108-84b9d5f5a75fa9e199f0cf6fc44970bc
  ```
  The bookmark shown above is historical; obtain a fresh bookmark before any future recovery operation. No restore was run for this release.

## Approved Production execution — 2026-10-18

- Release source commit: `e4b682abbf8f08a9138ae32bb395816327604f57`, based on `95a257f65e255e03146675ebd058372c13b0e392`.
- Preflight passed: performance tests 21/21; typecheck; Next.js build; Cloudflare build/check; Wrangler Worker dry-run. The project has no literal `test` or `check` npm script; the available equivalents `test:performance` and `check:cloudflare` passed.
- Migration SQL SHA-256: `694E4818DD06565E6DFDD9625E8E331D829AC36C5ED11CC51F80D83EC639CBD4`.
- Fresh pre-migration Time Travel bookmark: `00000071-00000000-00005108-63b11edf65ee7375e1edbbd35741b2cc`.
- Applied only `0002_telemetry_deal_ledger.sql` to D1 `helix-performance` (`da6d2ee3-cfba-4d5a-8117-d6e1e9cb9770`). The migration registry now contains only this migration.
- Verified the original public payload remained 0 net profit / 0 closed trades, with the same update time, payload length, and two points. The existing single historical snapshot remained unchanged. Baseline copy provenance is `copied_from_live_state_before_ledger`; control mode is `legacy_baseline`, revision 0, and no ledger deals have been ingested.
- Deployed only Worker `helix-performance`, version `a5ecfe66-6bf8-4dc6-9b78-cb832e2d6ddb`, message `R1 persistent landing telemetry ledger`.
- Live `/api/performance` returned the preserved baseline with `live_status=legacy_baseline_preserved`; public response contained neither `account_login` nor `account_hash`.
- Publisher connectivity is **not yet proven**: no MT5 terminal was available in the session and Production ledger count remains 0. No synthetic request or trade was sent. Await the next real publisher sync; do not attest coverage or publish cumulative ledger statistics until separately verified.
- No Production restore was performed. R1 status: **LIVE for capture path, PARTIAL pending first real publisher sync and historical coverage verification**.
