# R1 baseline

- Workspace candidate: `helix-cloudflare-release/`, git worktree at `cloudflare-landing`, baseline `3647df6`.
- Worktree was clean before work. A new local branch `codex/helix-portal-ui-otp-r1` was created; no commit/push/deploy has been made.
- Production source mapping remains NOT VERIFIED. This branch is a local candidate only.
- VIP runtime is static HTML/CSS/JS at `public/vip/`; backend is Cloudflare Pages Functions under `functions/`; Supabase SQL baseline is in `supabase/`. `helix-website/supabase/schema.sql` remains a separate reference and was not copied/overwritten.
- Existing route inventory: `/vip/api/member`, `/vip/api/member/bindings/:id`, `/vip/api/member/materials/:id`, `/vip/api/admin`, `/vip/api/admin/members`, `/vip/api/admin/licenses`, `/vip/api/admin/announcements`, `/vip/api/admin/materials`; public showcase routes and performance Worker remain separate.
- Existing menu counts: VIP 7 (`Dashboard`, `My Licenses`, `MT5 Accounts`, `License Activity`, `Announcements`, `Materials`, `My Profile`); Admin 5 (`Dashboard`, `Member`, `License`, `Announcement`, `Material`).
- Existing schema includes `helix_members`, `helix_licenses`, `helix_license_bindings`, `helix_license_events`, announcements/materials, while base `helix_series` and public performance schema exist only in sibling `helix-website/supabase/schema.sql` in this workspace. Production metadata remains NOT VERIFIED.
- `helix_touch_binding` exists but does not implement OTP and is not called by portal/EA source. Existing publisher sources are telemetry publishers, not `LIVE_R7_UI_CLICK_FIX`.
- A `.dev.vars` file exists at `helix-website/performance-worker/.dev.vars`. Its contents were not read, copied or printed. Treat `PUBLISHER_API_KEY` as potentially exposed and rotate it manually; do not rotate `ACCOUNT_HASH_SALT` without an identity migration plan.

## Baseline local checks (2026-10-11)

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build:cloudflare` | PASS; static export built |
| `npm run check:cloudflare` | PASS; 75 files |
| `node --test performance-worker/metrics.test.mjs` | PASS; 8 tests |
| `npm test --if-present` | PASS/no test script configured |

## Baseline hashes (SHA-256)

| Path | Hash |
|---|---|
| `public/vip/index.html` | `4091DB7216D19BF48DABD07567EA8236750C2B40F3703424A2205A584C80A202` |
| `public/vip/admin/index.html` | `F442005DB95C97271AEFA5769AFB0DF3A346F6083098605C079B192AEDE042FB` |
| `public/vip/login.html` | `5A20594839245E4C85CE0F98697013A424555F2827DFFAE4EAA926778E085975` |
| `public/vip/portal.css` | `B74550A71D7EDD1019BC0DDA85635B5B8CA90BF44F0013F79A759A829813B77A` |
| `functions/vip/api/[[path]].js` | `26A4A5DD9FC19595065E1C2EC80FC88B02D8E808EC6B3B398D7181AC78ED1A1A` |
| `supabase/license-schema.sql` | `55AAA6A4D8663E036DB28E75CE44E84BFA78B7EE49B2F3F717FE09E3079B45E4` |
| `cloudflare/_redirects` | `5036AEF1D4D83F10BC53D9F5EE087C6E197E345ABFCEF658F7BE6C1A8B6A019D` |
| `cloudflare/_headers` | `2D5D966F538BF58C937F05575CBA297DBAB31F93A566A7999DDA64D50522A6CC` |

Touched areas: static portal pages and CSS/assets; VIP API dispatcher and new modular Pages Function routes/shared helpers; additive Supabase migration/preflight/verification SQL; OTP/UI contract tests; R1 design/API/manual/QA documentation. SQL aggregation formulas were not executed locally. No EA source is in scope.
