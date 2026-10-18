import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202610180001_helix_r2_multi_product_universal_slots.sql', import.meta.url));
const validated = readFileSync(new URL('../supabase/validated/HELIX_R2_STAGING_VALIDATED_MIGRATION.sql', import.meta.url));
const report = readFileSync(new URL('../supabase/validated/HELIX_R2_CLOUD_STAGING_VALIDATION_REPORT.md', import.meta.url), 'utf8');

test('release migration is byte-identical to Cloud Staging-validated SQL', () => {
  const expected = 'bcf7d829cecee9bfce135fa30a08fca62dfe082cea5a2b71ba7fb23332af4ae4';
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(validated), expected);
  assert.equal(hash(migration), expected);
  assert.deepEqual(migration, validated);
  assert.match(report, new RegExp(expected));
});
