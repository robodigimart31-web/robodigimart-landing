# HELIX Portal Security Review

**Review date:** 12 October 2026  
**Scope:** source changes for VIP/Admin announcement and material workflows, shared VIP API patterns, Cloudflare response headers, and dependency advisory check.  
**Method:** static code review, negative/unit tests, production-build validation. No destructive or exploit traffic was sent to Production.

## Results

| Area | Result | Evidence and boundary |
|---|---|---|
| SQL/PostgREST injection | **PASS for content routes reviewed** | Announcement/material IDs must match UUID syntax before use; write fields are explicit allowlists; categories are enum allowlists; text fields have maximum lengths; REST filters URL-encode the validated ID. Database requests use the server-only service-role secret. This is a code review, not a full audit of every RPC/schema. |
| Stored/reflected XSS | **Mitigated in reviewed content flows** | Titles, snippets, categories, attributes, and full announcement text are escaped before HTML rendering; full announcement is rendered as text with preserved newlines rather than interpreted HTML. External links require HTTPS and reject embedded credentials. CSP now blocks objects/framing and limits scripts to same-origin plus the existing Supabase JS CDN. The portal still requires `'unsafe-inline'` because its current pages contain inline scripts; this weakens CSP against a future injection bug. |
| Brute force/content abuse | **Partial PASS** | Admin content writes require an authenticated admin session and use server-side rate limiting (40 writes/minute/member); upload body has a 55 MB request limit and a 50 MB file limit. Existing OTP/license endpoints also have per-route limits. Supabase Auth password-login throttles, Cloudflare WAF/bot rules, and global traffic controls are account settings and were not inspected or stress-tested here. |
| Web defacement | **Source controls reviewed; platform controls unverified** | Content mutations are admin-only, require a branded confirmation in the portal, and validate input. An admin account compromise can still publish/replace content by design. GitHub branch protections, Cloudflare account MFA/roles, and deployment approvals need account-level verification. |
| Malware/ransomware injection | **Partial mitigation; unresolved scanner gap** | Material storage is private; signed downloads are short-lived; size, extension, MIME, and magic bytes are checked for common file formats; uploads are not executed by the site. No antivirus/sandbox scanning service is configured in this source. ZIP, EX5, and MQ5 can still contain harmful payloads for a member who downloads/runs them. Admins must inspect files before publication; automated malware detection remains a separate control. |
| CMS/framework/dependency exploit | **No vulnerable production dependency reported** | `npm audit --omit=dev` returned zero vulnerabilities. This does not prove the runtime or transitive supply chain is invulnerable. The site uses static Next.js export plus Cloudflare Pages Functions, not a writable CMS. Keep lockfile audits and framework patches current. |

## Changes made with this review

- Added content-specific input limits, category allowlists, UUID validation, HTTPS URL validation, and server-side admin write throttling.
- Added MIME/signature checks for PDF, MP4, ZIP, PNG, JPEG, and WEBP, plus UTF-8/null-byte checks for TXT/MQ5 and upload size limits.
- Added restrictive security headers including CSP, `nosniff`, frame denial, referrer policy, and restricted browser permissions. Inline script allowance remains a documented limitation.
- Added tests for required/length-bounded text, unsafe URL rejection, spoofed file type rejection, and upload size cap.

## Checks run

- `node --test tests/*.test.mjs`: all tests passed.
- `npm run build:cloudflare`: passed.
- `npm run typecheck`: passed.
- `npm run check:cloudflare`: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.

## Follow-up controls outside this source change

1. Confirm Supabase Auth rate limits/CAPTCHA and Cloudflare WAF/bot protections in their dashboards; those controls are not represented in this repository.
2. Add malware scanning/quarantine before a new material can be published, especially ZIP, EX5, and MQ5 artifacts. Until then, require admin source review and trusted origin.
3. Move portal inline JavaScript into same-origin files, then remove `'unsafe-inline'` from `script-src`.
4. Verify GitHub branch protection, Cloudflare MFA/least-privilege access, and deployment audit history.

This review is a scoped code assessment, not a penetration test or certification. Do not describe unresolved external controls as PASS until they are checked in the provider accounts.
