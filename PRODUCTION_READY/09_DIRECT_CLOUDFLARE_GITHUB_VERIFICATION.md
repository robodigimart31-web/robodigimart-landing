# Direct Cloudflare and GitHub verification

Checked: 2026-10-11 (Asia/Jakarta). Verification used read-only Cloudflare dashboard inspection, Chrome route smoke tests, and read-only Git commands. No deployment, push, merge, production SQL, or secret changes were performed.

## Result

**Cloudflare production mapping: VERIFIED. GitHub deployment source mapping: VERIFIED.** Cloudflare Pages project `helix-website` is connected to `robodigimart31-web/robodigimart-landing`; production branch is `cloudflare-landing`; automatic deployments are enabled. Build command is `npm run build:cloudflare && npm run check:cloudflare`, output is `cloudflare-dist`, and root directory is blank. Custom domains `robodigimart.com`, `www.robodigimart.com`, and `vipmember.robodigimart.com` are all Active with SSL enabled.

Current production deployment SHA: `3647df6ccaabc5d384e66d9d18f200b1c7219878` (short SHA `3647df6`), description “Complete HELIX VIP admin and member workflows”. Deployment URL: `https://0147ad83.helix-website-bkw.pages.dev`. The deployment source/branch/commit matches the Git remote `cloudflare-landing` ref and local worktree base commit. All additional R1 implementation files currently in the worktree remain uncommitted and unpushed; they are **not** in production.

## Evidence

- Git remote: `https://github.com/robodigimart31-web/robodigimart-landing.git` (read-only `git ls-remote`).
- Remote refs: `cloudflare-landing` → `3647df6ccaabc5d384e66d9d18f200b1c7219878`; `main` and remote `HEAD` → `c15d839fa4237783d2038d22c1af9f64bb9606ff`.
- Cloudflare dashboard showed connected repository, production branch, auto-deploy setting, build command/output, all three Active domains, and the current production commit above.
- The local `.github/workflows` contains `check.yml`, not a deploy workflow. Production deploy method is Cloudflare Pages Git integration with automatic deployment from `cloudflare-landing`.
- GitHub CLI was not available, so branch-protection configuration and GitHub Actions run history were not inspected directly. These do not change the verified Cloudflare deployment source path.

## Production route smoke test

Read-only Chrome test of `https://vipmember.robodigimart.com/vip/login` loaded the HELIX VIP login page with SSL. The subdomain root `https://vipmember.robodigimart.com/` currently resolves to the marketing homepage `/id` instead of the VIP shell. The current local `_redirects` host-specific entries cannot fix this because Cloudflare Pages `_redirects` does not support matching by hostname ([Cloudflare Pages redirects](https://developers.cloudflare.com/pages/configuration/redirects/)). A new local `functions/_middleware.js` routes the VIP hostname root to `/vip/` and shortcuts to the existing portal routes; 12 portal contract tests and Cloudflare build/check pass. This middleware is uncommitted and not deployed, so root-path correction remains pending the production approval/deployment gate.

## Local-to-production differences and remaining checks

The local working branch is `codex/helix-portal-ui-otp-r1`, while production tracks `cloudflare-landing`. Worktree changes are uncommitted and not deployed. The checked-out base SHA is the current production SHA. Owner screenshots confirmed `vipmember` CNAME → `helix-website-bkw.pages.dev`, Proxied, TTL Auto. Cloudflare Pages requires a CNAME to the project's `<project>.pages.dev` hostname ([Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)).

After final production approval and deployment of the prepared change, smoke-test `https://vipmember.robodigimart.com/`, `/login`, `/admin`, and `/reset-password`. Complete isolated database scenario testing and production schema compatibility review before final production approval. Do not push changes: any push to `cloudflare-landing` automatically deploys. Do not run production SQL or deploy until the owner gives final approval.
