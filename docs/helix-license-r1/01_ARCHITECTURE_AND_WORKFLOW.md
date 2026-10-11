# Architecture and workflows

This is a local implementation candidate on `codex/helix-portal-ui-otp-r1`; it has not been deployed or connected to a staging database.

## Pairing

```text
Admin assigns entitlement (member, product, 730-day duration, max 5 slots)
  -> Supabase Auth invite/member profile
  -> frozen EA R7 requests POST /api/license/v1/pair/start
  -> Cloudflare creates short-lived pairing code + independent 256-bit session proof
  -> member signs in at /vip/ and chooses an existing license
  -> POST /vip/api/member/pairings/lookup shows broker/server and masked login
  -> member confirms -> transaction locks license, enforces slot cap, binds account,
     starts expiry on first activation, records event, creates hashed session
  -> EA polls with session proof; Cloudflare returns Ed25519-signed entitlement
  -> EA syncs about every 24h; network retry target 4h; offline grace max 7d
```

The short code is never accepted as the polling credential. Pair-code and session proofs are stored as hashes. Rate limiting is enforced by an atomic SQL RPC once the migration is installed. The default expiry is 730 days (a fixed duration, not a calendar-year calculation). Existing licenses keep their current expiry and `legacy_fixed` policy.

`active`, `suspended`, `revoked`, and `expired` are server decisions. Pending first-activation expiry is represented by `expires_at IS NULL` plus `activation_policy='first_activation'`. Transport failure is distinct from an authorization rejection. The exact EA offline/safety behavior remains for the frozen `LIVE_R7_UI_CLICK_FIX` integration and is not claimed as implemented here.

## Member email change

Member creates a request -> admin reviews in the existing Member menu -> member starts Supabase Auth email verification after approval -> Auth trigger updates `helix_members.email` and marks the request complete only after confirmation. A database guard rejects direct unapproved Auth email changes.

## Performance privacy

Deal ingestion requires a valid license session proof. Deals and completed positions are scoped to a license binding. A complete position lifecycle must net to zero volume, have one currency, avoid `INOUT`, and use an explicitly verified magic allowlist. That allowlist is intentionally empty until the R7 source and magic values are reviewed; therefore real dashboard metrics remain an honest empty state. Mixed-currency account totals are not combined. Family attribution is not guessed.

Public showcase and existing D1 performance Worker remain unchanged. VIP stays at 7 menu items; Admin stays at 5. Performance is a VIP Dashboard panel; pairing sits in My Licenses/MT5 Accounts; email requests sit in Member/My Profile.
