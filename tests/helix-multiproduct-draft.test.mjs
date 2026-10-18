import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const migration = read('../supabase/migrations/202610180001_helix_r2_multi_product_universal_slots.sql');
const api = read('../functions/vip/api/[[path]].js');
const pairingStart = read('../functions/api/license/v1/pair/start.js');
const memberPortal = read('../public/vip/index.html');
const adminPortal = read('../public/vip/admin/index.html');

test('staging-validated migration uses existing general settings and does not reinterpret per-license max_accounts', () => {
  assert.match(migration, /setting_key,setting_value,change_reason[\s\S]*?mt5_member_slot_max/);
  assert.doesNotMatch(migration, /helix_admin_settings/);
  assert.match(migration, /mt5_slot_capacity integer not null default 0/);
  assert.match(migration, /mt5_slot_capacity % 5 = 0/);
  assert.match(api, /PORTAL_UNIVERSAL_SLOTS_ENABLED/);
});

test('new licenses default to dedicated product scope and suite grants are frozen explicitly', () => {
  assert.match(migration, /values\(new\.id,'product',array\[new\.product_slug\],'dedicated'\)/);
  assert.match(migration, /Keep existing helix_suite policy rows intact/);
  assert.match(migration, /helix_guard_pairing_product_scope/);
  assert.match(migration, /all_access_eligible boolean not null default false/);
});

test('legacy pairing wire contract remains SHA-256 and does not accept registry HMAC from EA', () => {
  assert.match(pairingStart, /const fingerprint = await sha256\(`\$\{normalizedServer\}:\$\{login\}`\)/);
  assert.match(pairingStart, /rpc\(env, "helix_pairing_start"/);
  assert.doesNotMatch(pairingStart, /p_registry_fingerprint/);
  assert.match(migration, /helix_pairing_start_with_registry/);
  assert.match(migration, /helix_pairing_approve_universal/);
});

test('slot registry backfill is quarantined, deduplicated and linked without deleting history', () => {
  assert.match(migration, /fingerprint_version smallint not null default 1 check \(fingerprint_version >= 0\)/);
  assert.match(migration, /'unreconciled'/);
  assert.match(migration, /group by l\.member_id,lower\(regexp_replace\(trim\(b\.broker_server\)/);
  assert.match(migration, /update public\.helix_license_bindings b\s+set member_mt5_account_id=a\.id/);
  assert.match(migration, /idempotency_key uuid not null unique/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /hashtextextended\(p_idempotency_key::text,0\)/);
  assert.doesNotMatch(migration, /delete from public\.helix_(telemetry_deals|completed_trades)/i);
});

test('release purge protects validated history and leaves cron schedule untouched', () => {
  assert.match(migration, /not exists\(select 1 from public\.helix_telemetry_deals/);
  assert.match(migration, /not exists\(select 1 from public\.helix_completed_trades/);
  assert.doesNotMatch(migration, /cron\.(schedule|unschedule)/i);
  assert.doesNotMatch(migration, /drop table|truncate table/i);
});

test('performance RPC signatures stay at existing five arguments and include released binding history', () => {
  const performance = migration.slice(migration.indexOf('-- D. Read-only entitlement queries'), migration.indexOf('-- Preserve the existing server-only RPC execution model.'));
  assert.match(performance, /helix_member_performance_summary_v2\(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null\)/);
  assert.doesNotMatch(performance, /p_include_released/);
  assert.doesNotMatch(performance, /b\.released_at is null/);
  assert.doesNotMatch(api, /p_include_released/);
});

test('product materials require entitlement and private storage; checksum hashes bytes', () => {
  assert.match(api, /PRODUCT_MATERIAL_REQUIRES_PRIVATE_STORAGE/);
  assert.match(api, /PRODUCT_MATERIAL_PRIVATE_STORAGE_REQUIRED/);
  assert.match(api, /ownedProductIds\.has\(rows\[0\]\.ea_product_id\)/);
  assert.match(api, /async function digestBytes\(value\)/);
  assert.match(api, /file_checksum_sha256 = await digestBytes\(await file\.arrayBuffer\(\)\)/);
  assert.match(api, /expiresIn: 600/);
});

test('member dashboard renders catalog and universal slot summary only behind response feature flag', () => {
  assert.match(memberPortal, /if\(!state\.data\?\.multi_product_enabled\)return html/);
  assert.match(memberPortal, /productCatalog\(\)\}/);
  assert.match(memberPortal, /memberSlotCard\(\)\}<div class="dashboard-grid">/);
  assert.match(memberPortal, /Katalog Produk/);
  assert.match(memberPortal, /Pool berlaku untuk semua produk dan license/);
  assert.match(memberPortal, /state\.data\?\.universal_slots_enabled\).*const pool=state\.data\.slot_pool/);
  assert.match(memberPortal, /akun unik dari \$\{pool\.total\} slot member-wide/);
  assert.match(memberPortal, /const legacyMemberPage=page;page=function\(\).*state\.page==='accounts'/);
  assert.match(memberPortal, /tidak dihitung per license.*berbagi pool member-wide/);
});

test('R2 admin exposes catalog, package entitlements, version controls and member-wide slot packages', () => {
  assert.match(adminPortal, /data-r2-product-create/);
  assert.match(adminPortal, /Dedicated/);
  assert.match(adminPortal, /Bundle/);
  assert.match(adminPortal, /HELIX ALL/);
  assert.match(adminPortal, /data-r2-product-versions/);
  assert.match(adminPortal, /data-r2-slot/);
  assert.match(adminPortal, /const helixLegacyStats=stats;stats=function\(\).*state\.data\?\.universal_slots_enabled/);
  assert.match(adminPortal, /Member-wide pool/);
  assert.match(adminPortal, /const bindingsSection=`<section class="panel section">.*html=html\.replace\(bindingsSection,''\)/);
  assert.match(adminPortal, /data-r2-release-account/);
  assert.match(adminPortal, /full-account release/);
  assert.match(adminPortal, /\[5,10,15\]/);
  assert.match(adminPortal, /data\.universal_slots_enabled/);
  assert.match(api, /helix_admin_ensure_member_initial_slots/);
  assert.match(api, /helix_request_mt5_account_release/);
  assert.match(api, /verifiedUser\(request, env, pathname\.startsWith\("admin\/"\)\)/);
});

test('product announcements and private materials are entitlement-filtered on the server', () => {
  assert.match(api, /visibleAnnouncements = multiProductEnabled[\s\S]*ownedProductIds\.has\(item\.ea_product_id\)/);
  assert.match(api, /visibleMaterials = multiProductEnabled[\s\S]*ownedProductIds\.has\(material\.ea_product_id\)/);
  assert.match(api, /PRODUCT_MATERIAL_PRIVATE_STORAGE_REQUIRED/);
  assert.match(api, /ownedProductIds\.has\(rows\[0\]\.ea_product_id\)/);
});

test('Email Change keeps the request/password/admin workflow and preserves product grants before suspension', () => {
  assert.match(memberPortal, /member\/email-change-requests/);
  assert.match(memberPortal, /Password login portal VIP/);
  assert.match(memberPortal, /akses, license, dan koneksi pada akun lama akan dinonaktifkan/);
  assert.match(api, /helix_admin_set_license_product_policy/);
  assert.match(api, /OLD_ACCOUNT_SUSPEND_FAILED/);
});

test('VIP and Admin portal inline scripts parse after R2 UI integration', () => {
  for (const [file, html] of [['public/vip/index.html', memberPortal], ['public/vip/admin/index.html', adminPortal]]) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length, `${file} should contain inline application scripts`);
    for (const [index, script] of scripts.entries()) assert.doesNotThrow(() => new vm.Script(script[1]), `${file} inline script ${index + 1}`);
  }
});
