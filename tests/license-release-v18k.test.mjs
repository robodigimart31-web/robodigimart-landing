import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestPost as licenseSync } from '../functions/api/license/v1/sync.js';
import { onRequestPost as releaseAck } from '../functions/api/license/v1/release/ack.js';
import { onRequestGet as portalStatus } from '../functions/api/portal/v1/status.js';

const sessionSecret = 'test-session-proof-that-is-long-enough-for-v18k';
const releaseId = '11111111-1111-4111-8111-111111111111';
const makeSyncRequest = () => new Request('https://helix.test/api/license/v1/sync', {
  method: 'POST',
  headers: { authorization: `Bearer ${sessionSecret}`, 'content-type': 'application/json' },
  body: '{}',
});

test('v1.8k sync selects the release-aware RPC only when enabled and returns PENDING_RELEASE as a hard state', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const target = String(url);
    if (target.includes('/rpc/helix_rate_limit')) return Response.json({ allowed: true });
    if (target.includes('/rpc/helix_license_sync_v18k')) {
      calls.push('v18k');
      return Response.json({ state: 'PENDING_RELEASE', release_id: releaseId, server_time: '2026-10-12T10:00:00Z' });
    }
    if (target.includes('/rpc/helix_license_sync')) {
      calls.push('legacy');
      return Response.json({ state: 'REVOKED', error_code: 'SESSION_REVOKED' });
    }
    throw new Error(`Unexpected backend call: ${target}`);
  });
  const legacy = await licenseSync({ request: makeSyncRequest(), env: { SUPABASE_SERVICE_ROLE_KEY: 'test', PAIRING_HASH_SECRET: 'a-testing-pair-secret-that-is-long-enough-32', PORTAL_OTP_ENABLED: 'true' } });
  assert.equal(legacy.status, 403);
  assert.deepEqual(calls, ['legacy']);
  const current = await licenseSync({ request: makeSyncRequest(), env: { SUPABASE_SERVICE_ROLE_KEY: 'test', PAIRING_HASH_SECRET: 'a-testing-pair-secret-that-is-long-enough-32', PORTAL_OTP_ENABLED: 'true', PORTAL_LICENSE_RELEASE_ACK_V18K: 'true' } });
  const body = await current.json();
  assert.equal(current.status, 200);
  assert.equal(body.state, 'PENDING_RELEASE');
  assert.equal(body.release_id, releaseId);
  assert.equal(body.next_sync_seconds, 900);
  assert.deepEqual(calls, ['legacy', 'v18k']);
});

test('release ACK requires the feature, valid session proof, UUID, and clean pending-order confirmation', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const target = String(url);
    if (target.includes('/rpc/helix_rate_limit')) return Response.json({ allowed: true });
    if (target.includes('/rpc/helix_release_ack_v18k')) {
      calls.push(target);
      return Response.json({ ok: true, state: 'PENDING_RELEASE', release_id: releaseId, acked_sessions: 1, required_sessions: 2 });
    }
    throw new Error(`Unexpected backend call: ${target}`);
  });
  const makeAck = ({ proof = sessionSecret, body = { release_id: releaseId, pending_orders_clean: true }, enabled = true } = {}) => new Request('https://helix.test/api/license/v1/release/ack', {
    method: 'POST', headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const disabled = await releaseAck({ request: makeAck({ enabled: false }), env: { PORTAL_LICENSE_RELEASE_ACK_V18K: 'false' } });
  assert.equal(disabled.status, 503);
  const noProof = await releaseAck({ request: makeAck({ proof: '' }), env: { PORTAL_LICENSE_RELEASE_ACK_V18K: 'true' } });
  assert.equal(noProof.status, 401);
  const dirty = await releaseAck({ request: makeAck({ body: { release_id: releaseId, pending_orders_clean: false } }), env: { PORTAL_LICENSE_RELEASE_ACK_V18K: 'true', SUPABASE_SERVICE_ROLE_KEY: 'test', PAIRING_HASH_SECRET: 'a-testing-pair-secret-that-is-long-enough-32' } });
  assert.equal(dirty.status, 422);
  const invalidId = await releaseAck({ request: makeAck({ body: { release_id: 'bad', pending_orders_clean: true } }), env: { PORTAL_LICENSE_RELEASE_ACK_V18K: 'true', SUPABASE_SERVICE_ROLE_KEY: 'test', PAIRING_HASH_SECRET: 'a-testing-pair-secret-that-is-long-enough-32' } });
  assert.equal(invalidId.status, 422);
  const valid = await releaseAck({ request: makeAck(), env: { PORTAL_LICENSE_RELEASE_ACK_V18K: 'true', SUPABASE_SERVICE_ROLE_KEY: 'test', PAIRING_HASH_SECRET: 'a-testing-pair-secret-that-is-long-enough-32' } });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).state, 'PENDING_RELEASE');
  assert.equal(calls.length, 1);
});

test('public status exposes release readiness and keeps telemetry unrelated', async () => {
  const response = await portalStatus({ env: { PORTAL_OTP_ENABLED: 'true', PORTAL_LICENSE_RELEASE_ACK_V18K: 'true', PORTAL_PERFORMANCE_ENABLED: 'true', EA_R7_TELEMETRY_READY: 'true' } });
  const result = await response.json();
  assert.equal(result.features.otp_pairing, true);
  assert.equal(result.features.license_release_ack_v18k, true);
  assert.equal(result.features.trading_performance, true);
  assert.equal(result.readiness.license_release_ack_v18k, 'enabled');
});

test('SQL enforces pending slot retention, per-session ACKs, idempotence, and audited force release', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202610130001_helix_license_release_ack_v18k.sql', import.meta.url), 'utf8');
  assert.match(sql, /release_state='pending_release'/);
  assert.match(sql, /'slot_retained',true/);
  assert.match(sql, /v_acked<v_required/);
  assert.match(sql, /release_state='released',released_at=v_now/);
  assert.match(sql, /admin_force_release/);
  assert.match(sql, /warning_acknowledged',true/);
});

test('portal code exposes PENDING RELEASE and gates admin force release behind an explicit acknowledgement', async () => {
  const api = await readFile(new URL('../functions/vip/api/[[path]].js', import.meta.url), 'utf8');
  const member = await readFile(new URL('../public/vip/index.html', import.meta.url), 'utf8');
  const admin = await readFile(new URL('../public/vip/admin/index.html', import.meta.url), 'utf8');
  const portalActions = await readFile(new URL('../public/vip/helix-ui/js/portal-r1.js', import.meta.url), 'utf8');
  assert.match(api, /helix_request_binding_release_v18k/);
  assert.match(api, /json\.force_release_acknowledged !== true/);
  assert.match(member, /PENDING RELEASE/);
  assert.match(admin, /data-release=/);
  assert.match(portalActions, /force_release_acknowledged:Boolean\(v18k\)/);
  assert.match(portalActions, /Force Release langsung membebaskan slot/);
});
