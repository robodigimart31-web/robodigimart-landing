# Production smoke test (after final approval and deployment)

Use owner-controlled accounts only. Never paste passwords, JWTs, invitation links, pairing codes, private keys, service-role keys, or customer PII into reports.

## Before enabling feature flags

1. Open https://vipmember.robodigimart.com/vip/login/ and https://www.robodigimart.com/vip/login/. Confirm login UI, CSS, logos, SVGs, and WebP backgrounds load without console errors.
2. Sign in as a test member. Confirm it lands on /vip/, shows no sample users/licenses/performance, and Logout ends the session.
3. Sign in as the owner admin. Confirm /vip/admin/ and exactly five existing menus. Confirm a member cannot load admin APIs.
4. With flags false, admin license controls must be disabled with a readiness notice. Existing licenses must show their real expiry and slot totals.
5. The member performance panel must explicitly wait for verified EA R7 telemetry and show no fabricated numbers.

## After migration and activation

1. Invite a test member under Admin → Member. Verify Supabase Auth delivery, activation, password creation, and login.
2. Create one license with 730 days and five slots. The API/browser must never return a full manual key or hash. Repeating an idempotency request must not create a duplicate.
3. Pair one test terminal. Verify license selection, broker/server confirmation, masked login and explicit user confirmation. Check first activation expiry is about 730 days and a sixth distinct account is denied.
4. Release a binding with an audit reason. Verify session revocation and freed slot. Verify reducing max slots below active usage is denied.
5. Test suspension/revocation and server sync denial. EA offline behavior must be separately tested against frozen LIVE_R7_UI_CLICK_FIX.
6. Test member email request, admin approval, Auth verification, profile update, password reset and invite redirects on the actual domain.
7. Before telemetry is verified, performance must remain empty. After verified R7 ingestion, validate full closed-position totals and ensure currencies are not combined.
8. Check browser Network/Console and Cloudflare logs for 4xx/5xx, missing assets, and exposed secrets.

If any check fails, turn the relevant feature flag off first, capture only sanitized error code/time, then follow 07_ROLLBACK_PLAN.md. Do not retry production SQL with ad hoc edits.
