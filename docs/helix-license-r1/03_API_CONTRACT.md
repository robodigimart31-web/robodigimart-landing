# API contract (draft)

All routes run as Cloudflare Pages Functions. The browser never receives a service-role key, pairing session proof, signing key, or license-key hash. Request/response examples use dummy values only. License creation accepts a per-form UUID idempotency key so network retry does not create another assignment.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/license/v1/pair/start` | EA session proof returned only to EA | Create 8-digit, 10-minute OTP request; returns OTP once and independent random session proof. |
| `POST /api/license/v1/pair/poll` | Bearer session proof | Pending/approved/rejected state; approved response includes signed Ed25519 entitlement. |
| `POST /api/license/v1/sync` | Bearer session proof | Revalidate active license and return current signed entitlement. |
| `POST /api/telemetry/v1/deals` | Bearer session proof | Bounded/idempotent deal batch; no member ID accepted from caller. |
| `POST /vip/api/member/pairings/lookup` | Supabase member JWT | Resolve code only against a member-owned license; returns confirmation details. |
| `POST /vip/api/member/pairings/approve` | Supabase member JWT + explicit confirmation | Atomic bind and first activation. |
| `GET /vip/api/member/performance` | Supabase member JWT | Optional `license_id`, `binding_id`, `from`, `to`, and supported `family=unclassified` filters. |
| `POST/GET /vip/api/member/email-change-requests` | Supabase member JWT | Submit/list own email requests. |
| `GET /vip/api/admin/email-change-requests` | Admin JWT | Pending email review queue. |
| `POST /vip/api/admin/email-change-requests/:id` | Admin JWT | `approve` or `reject`; approved requests still require member-initiated verification. |

Pair start rate default: 20/IP/hour; lookup 15/IP+member/10m; approve 8/IP+member/10m; poll 15/session/minute; sync 20/session/hour; telemetry 30/session/10m. Rate subjects are HMACed before storage. Retain Cloudflare edge rate protections as an outer layer. Responses use `429 RATE_LIMITED` and a retry interval. The API is not production-ready until migration/RPC grants, secrets, staging tests, and EA contract verification are complete.

Telemetry accepts at most 2,000 deals / 1.5 MB, validates timestamps, ticket/position IDs, direction, entry kind, symbol, currency, numeric fields, and magic. Metrics count completed positions, not individual deals. Metrics return `NO_DATA` or `MIXED_CURRENCY` without fake zeros. Only verified allowlisted magic entries are aggregated.
