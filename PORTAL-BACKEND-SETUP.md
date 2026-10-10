# HELIX VIP portal

The VIP pages are static Cloudflare Pages assets with server operations in `functions/vip/api/[[path]].js`. The browser uses the Supabase publishable key only. The Pages Function validates the Supabase access token, reads the member role from `helix_members`, and uses `SUPABASE_SERVICE_ROLE_KEY` only on the server for invitations and protected database operations.

## Supabase tables

Run these SQL files in order in Supabase SQL Editor:

1. `supabase/schema.sql`
2. `supabase/license-schema.sql`
3. `supabase/license-policies.sql`
4. `supabase/auth-trigger.sql`
5. `supabase/role-rpc.sql`

The invite trigger creates a `helix_members` row with the `member` role. Promote administrators through a trusted SQL editor only.

## Cloudflare Pages

The production Pages project must have the runtime secret `SUPABASE_SERVICE_ROLE_KEY` configured under Settings → Variables and Secrets. This secret is already present on the connected `helix-website` production project. Do not expose it as a `NEXT_PUBLIC_*` variable or commit it to the repository. Pages Functions are deployed from the repository's root `functions/` directory alongside the static output in `cloudflare-dist/`.

The account invitation and password reset emails are sent by Supabase Auth. Configure a production SMTP provider and allow these callback URLs in Supabase Auth URL Configuration:

- `https://www.robodigimart.com/vip/login?flow=invite`
- `https://www.robodigimart.com/vip/login?flow=recovery`

Member sign-up remains disabled. Admin invitations allow each member to set their own password from the invitation link.

## Operational scope

The live portal supports member invitations, reset links, account suspension, license creation and key rotation, entitlement status/expiry/slot changes, binding release, announcements, materials, and member read-only views. License keys are stored as SHA-256 hashes and shown to an admin only at creation or rotation.

The MT5 account-pairing handshake still requires the HELIX EA to call a production License API. The website must not invent a pairing code or mark a terminal active by itself. The current pages show server-confirmed account bindings and let the member/admin release a binding safely; they do not claim that the EA pairing API is live.

Material rows support HTTPS links. To host private downloadable files, configure a Supabase Storage bucket and signed upload/download routes before placing private file links here.
