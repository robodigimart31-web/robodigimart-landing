# HELIX EA License and Account Release Policy

This policy is the shared contract for HELIX QUADRIGA and every future HELIX EA, regardless of version, code name, or strategy family. Each EA must use the same server-side license lifecycle. Product-specific trading logic must not implement its own slot-release rules.

## Binding and slot rules

- A license slot represents one broker server, trading account login, and account fingerprint binding. Demo and real accounts each consume one slot. Multiple charts or EA families on the same account do not consume extra slots.
- A binding remains slot-consuming while its release state is `active` or `pending_release`. Only `released` frees the slot.
- Pairing must validate the authenticated member, license ownership and status, account fingerprint, demo/real mode, product policy, and slot quota on the server. Frontend checks are never authorization.
- Re-pairing an already active binding must recover that binding and must not create a duplicate slot. A pending or released binding must not be silently reactivated by sync or pairing; reactivation follows the server's explicit, audited pairing policy.

## Sync contract

- While v1.8k release policy is enabled, the EA requests license sync every 15 minutes and retries a failed sync after 15 minutes.
- After eight consecutive failed sync cycles or 120 minutes since the last verified `ACTIVE` entitlement, the EA must show `LICENSE SYNC REQUIRED` and stop opening new positions. A connection failure alone is not proof that a server-side release was acknowledged.
- Only transient network/service failures may use the signed offline deadline, which must never exceed 120 minutes or the license expiry. Server denials such as suspended, revoked, expired, not-owner, or pending release are authoritative and must not fall back to cached `ACTIVE` entitlement.
- On restart, the EA must restore its verified entitlement, failure counter, binding identity, and pending release identifier from durable terminal storage, then revalidate with the server. Reinstalling or attaching another chart must not reset server state or create another binding.
- A successful `ACTIVE` response refreshes the signed entitlement and last-success timestamp. The response's server time, expiry, binding ID, account fingerprint, product scope, and entitlement version must be verified before use.

## Release handshake

1. Member release requests create one idempotent release request and set the binding to `PENDING_RELEASE`. The slot remains occupied.
2. The next sync returns `PENDING_RELEASE` with the same unique `release_id`. The EA immediately blocks new entries, removes HELIX pending orders, and leaves already-open positions under the existing management rules.
3. Each live terminal session attached to that binding must independently verify that its HELIX pending orders are gone and send `POST /api/license/v1/release/ack` with its authenticated session proof, `release_id`, and `pending_orders_clean: true`.
4. ACK is authenticated, binding-scoped, idempotent, and only completes release after every unexpired, unrevoked session required by server policy has acknowledged. The server then marks the binding `RELEASED`, revokes its sessions, records an audit event, and frees the slot.
5. If a terminal is offline, ACK fails, an order cannot be verified as removed, or the EA reaches the local sync-failure limit, the server keeps the binding `PENDING_RELEASE`; it must never infer an ACK from timeout, missing session, or local state.
6. An administrator may use Force Release only after an explicit risk warning and reason. Force Release is an audited override, not the normal release path.

All future EAs must preserve these state names and meanings: `ACTIVE`, `PENDING_RELEASE`, `RELEASED`, `LICENSE SYNC REQUIRED`, and `LICENSE DENIED`. They must treat an unknown or malformed server state as denied for new entries and must not convert it to active access.

## Multiple sessions and terminal safety

- One account may have several active terminals or session proofs. Release accounting is per live server session, not per chart count.
- Every terminal must stop new entries after `PENDING_RELEASE`. ACK from one terminal cannot release a binding while another required live session remains unacknowledged.
- Expired or unreachable sessions are not treated as successful ACKs. Resolution requires that terminal to reconnect and acknowledge or an administrator to perform a warned, audited Force Release.
- Open-position handling is controlled by the EA's existing risk-management policy. License denial must block new entries and must not force-close open positions unless a separately approved trading policy explicitly requires it.

## Version and rollout policy

- All EA products and code names use the shared `/api/license/v1/pair/start`, `/pair/poll`, `/sync`, and `/release/ack` contract. Product identifiers and version policy are data sent to the server, not separate authorization implementations.
- A new EA release may change UI or trading modules, but it may not change sync cadence, offline deadline, release states, slot semantics, ACK authentication, or replay behavior without a documented protocol revision and matching backend contract tests.
- Before enabling a new protocol, compile the EA, run contract tests, and perform acceptance tests for active renewal, release online/offline, pending orders, open positions, 1–8 failed sync cycles, 120-minute cutoff, restart/recovery, duplicate ACK, multiple sessions, and authorization failures.
- Keep the feature flag off until the production schema is applied and the deployed backend supports every route used by that EA. Migrate first with the flag off, verify the additive schema and RPC permissions, deploy compatible backend/UI, then enable the flag and verify the public status endpoint.
- A global release flag may be enabled only after all terminals using the affected bindings support the protocol. If mixed versions must coexist, use a server-enforced binding-scoped rollout gate; never rely on a UI toggle or an EA-supplied version string alone.
- Rollback must not erase pending release requests, ACK records, binding state, or audit history. If the new code must be disabled, preserve slot occupancy and resolve pending releases explicitly; never fall back to immediate slot release for a pending binding.

## Separation from telemetry and trading logic

License sync and release state are authoritative for authorization. Telemetry sync, performance flags, broker history, Magic Base, or reporting availability must not grant or extend trading entitlement. Changes to licensing must not alter ML/RL/SHL/LGL strategy selection, order sizing, entry/exit rules, or management of existing positions.
