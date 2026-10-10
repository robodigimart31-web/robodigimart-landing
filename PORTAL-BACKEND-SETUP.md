# HELIX VIP backend setup

The first portal deployment is a safe UI prototype. The production license flow is prepared in `supabase/license-schema.sql`.

## What the migration provides

- `helix_members`: member/admin identity linked to Supabase Auth.
- `helix_licenses`: hashed license key, product, expiry, status, and account limit.
- `helix_license_bindings`: broker/server + account fingerprint bindings and slot release.
- `helix_license_events`: activation, sync, reset, suspend, revoke, and email audit trail.
- `helix_announcements` and `helix_materials`: content controlled by admin.
- `helix_touch_binding(...)`: an atomic, locked activation/sync function that prevents double slot allocation.

## One-time configuration still required

1. Create or open the Supabase project.
2. Run `schema.sql`, then `license-schema.sql`, then `license-policies.sql`, then `auth-trigger.sql` in the SQL Editor.
3. Enable email/password Auth (and configure production SMTP before inviting customers).
4. Add the Supabase URL and server-only service-role key as deployment secrets. Never put the service-role key in `public/vip` or browser JavaScript.
5. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from `.env.example` to the public build environment. Add `SUPABASE_SERVICE_ROLE_KEY` only as a server-side deployment secret.
6. Confirm the License API contract used by the EA: product slug, license credential, broker server, login, pairing code, seven-day sync, grace period, and reset cooldown.

The static portal currently shows demo data by design. The next implementation replaces its demo state with authenticated server routes, then connects the EA to the same license service. A portal button alone cannot activate an EX5 until that server contract and EA validation endpoint are implemented.
