import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareProductVersion } from '../functions/vip/api/[[path]].js';

const migration = readFileSync(new URL('../supabase/migrations/202610180001_helix_r2_multi_product_universal_slots.sql', import.meta.url), 'utf8');

test('numeric structured product versions do not compare lexicographically', () => {
  for (const version of ['1.9', '1.10', '1.19', '1.20', '2.0']) assert.notEqual(compareProductVersion(version, version), null);
  assert.equal(compareProductVersion('1.10', '1.9'), 1);
  assert.equal(compareProductVersion('1.19', '1.10'), 1);
  assert.equal(compareProductVersion('1.20', '1.19'), 1);
  assert.equal(compareProductVersion('2.0', '1.20'), 1);
  assert.equal(compareProductVersion('1.9c', '1.9'), -1);
  assert.equal(compareProductVersion('1.9c', '1.9d'), -1);
  assert.equal(compareProductVersion('1.10garbage', '1.10'), null);
  assert.equal(compareProductVersion('unknown', '1.9'), null);
  assert.equal(compareProductVersion('1.9999999', '2.0'), null);
  const within = version => compareProductVersion(version,'1.10') >= 0 && compareProductVersion(version,'1.20') <= 0;
  assert.equal(within('1.9'),false);
  assert.equal(within('1.10'),true);
  assert.equal(within('1.19'),true);
  assert.equal(within('1.20'),true);
  assert.equal(within('2.0'),false);
});

test('database pairing and catalog range checks use the same numeric comparator', () => {
  assert.match(migration, /create or replace function public\.helix_version_compare_numeric/);
  assert.match(migration, /helix_version_compare_numeric\(v_pair\.ea_version,p\.min_version\)>=0/);
  assert.match(migration, /helix_version_compare_numeric\(v_pair\.ea_version,p\.max_version\)<=0/);
  assert.match(migration, /PRODUCT_VERSION_RANGE_REQUIRES_MANUAL_RECONCILIATION/);
  assert.match(migration, /PRODUCT_VERSION_NOT_ALLOWED/);
  assert.match(migration, /helix_version_compare_numeric\(new\.ea_version,p\.min_version\)>=0/);
});

test('pair start retains QUADRIGA letter suffixes and rejects unstructured versions', () => {
  const pairStart = readFileSync(new URL('../functions/api/license/v1/pair/start.js', import.meta.url), 'utf8');
  assert.match(pairStart, /\\d\{1,6\}\(\?:\\\.\\d\{1,6\}\)\{1,3\}\[a-z\]\?/i);
  assert.match(pairStart, /const fingerprint = await sha256\(`\$\{normalizedServer\}:\$\{login\}`\)/);
});
