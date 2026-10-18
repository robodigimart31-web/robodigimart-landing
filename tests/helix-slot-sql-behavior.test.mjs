import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* Optional local SQL engine. */ }

const migration = readFileSync(new URL('../supabase/migrations/202610180001_helix_r2_multi_product_universal_slots.sql', import.meta.url), 'utf8');

test('PostgreSQL numeric version comparator matches API ordering and rejects malformed versions', { skip: !PGlite && 'Install @electric-sql/pglite transiently to run isolated PostgreSQL version checks' }, async () => {
  const comparator = /create or replace function public\.helix_version_compare_numeric\([\s\S]*?end \$\$;/i.exec(migration)?.[0];
  assert.ok(comparator, 'extract the actual comparator function from the staging-validated migration');
  const db = new PGlite();
  try {
    await db.exec(comparator);
    for (const value of ['1.9','1.10','1.19','1.20','2.0']) {
      assert.equal((await db.query('select public.helix_version_compare_numeric($1,$1) as cmp',[value])).rows[0].cmp,0);
    }
    for (const [left,right] of [['1.10','1.9'],['1.19','1.10'],['1.20','1.19'],['2.0','1.20'],['1.9d','1.9c']]) {
      assert.equal((await db.query('select public.helix_version_compare_numeric($1,$2) as cmp',[left,right])).rows[0].cmp,1);
    }
    assert.equal((await db.query("select public.helix_version_compare_numeric('1.9c','1.9') as cmp")).rows[0].cmp,-1);
    assert.equal((await db.query("select public.helix_version_compare_numeric('unknown','1.9') as cmp")).rows[0].cmp,null);
    assert.equal((await db.query("select public.helix_version_compare_numeric('1.10garbage','1.10') as cmp")).rows[0].cmp,null);
  } finally { await db.close(); }
});

test('PostgreSQL email handoff copies exact slot capacity and license expiry idempotently', { skip: !PGlite && 'Install @electric-sql/pglite transiently to run isolated email handoff checks' }, async () => {
  const extractFunction = name => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?end \\$\\$;`, 'i').exec(migration)?.[0];
  const transfer = extractFunction('helix_admin_transfer_member_slots');
  const preserveExpiry = extractFunction('helix_admin_preserve_email_change_expiry');
  assert.ok(transfer && preserveExpiry, 'use the actual email handoff RPCs from the staging-validated migration');
  const db = new PGlite();
  try {
    await db.exec(`
      create type public.helix_event_type as enum ('sync');
      create table public.helix_members(id uuid primary key,role text,mt5_slot_capacity int not null default 0,updated_at timestamptz default now());
      create table public.helix_general_settings(setting_key text primary key,setting_value jsonb);
      create table public.helix_member_mt5_accounts(id uuid primary key default gen_random_uuid(),member_id uuid,status text);
      create table public.helix_member_slot_events(id uuid primary key default gen_random_uuid(),member_id uuid,actor_id uuid,event_type text,capacity_delta int,capacity_before int,capacity_after int,idempotency_key uuid unique,reason text,metadata jsonb default '{}'::jsonb,created_at timestamptz default now());
      create table public.helix_licenses(id uuid primary key,member_id uuid,status text,deleted_at timestamptz,expires_at timestamptz,activation_policy text,first_activated_at timestamptz,duration_days int,issued_at timestamptz,entitlement_version bigint,created_at timestamptz default now(),updated_at timestamptz);
      create table public.helix_email_change_requests(id uuid primary key,member_id uuid,status text,expires_at timestamptz);
      create table public.helix_license_events(id uuid primary key default gen_random_uuid(),license_id uuid,actor_id uuid,event_type public.helix_event_type,metadata jsonb);
      insert into public.helix_general_settings values('mt5_member_slot_max','50'::jsonb);
      insert into public.helix_members(id,role,mt5_slot_capacity) values
        ('00000000-0000-4000-8000-000000000001','admin',0),
        ('00000000-0000-4000-8000-000000000002','member',15),
        ('00000000-0000-4000-8000-000000000003','member',0);
      insert into public.helix_licenses(id,member_id,status,expires_at,activation_policy,first_activated_at,duration_days,issued_at,entitlement_version,updated_at) values
        ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000002','active','2027-04-05 06:07:08.123+00','first_activation','2026-04-05 00:00:00+00',365,'2026-04-05 00:00:00+00',4,now()),
        ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000003','active',null,'first_activation',null,730,now(),1,now());
      insert into public.helix_email_change_requests values('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000002','pending',now()+interval '14 days');
      ${transfer}
      ${preserveExpiry}
    `);
    const callSlots = `select public.helix_admin_transfer_member_slots('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000301','email change slot handoff') as result`;
    assert.equal((await db.query(callSlots)).rows[0].result.capacity,15);
    assert.equal((await db.query(callSlots)).rows[0].result.idempotent,true);
    assert.deepEqual((await db.query('select mt5_slot_capacity from public.helix_members order by id')).rows.map(row=>row.mt5_slot_capacity),[0,15,15]);
    assert.equal((await db.query('select count(*)::int as count from public.helix_member_slot_events')).rows[0].count,1);
    const callExpiry = `select public.helix_admin_preserve_email_change_expiry('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000201') as result`;
    assert.equal(Date.parse((await db.query(callExpiry)).rows[0].result.expires_at),Date.parse('2027-04-05T06:07:08.123+00:00'));
    assert.equal((await db.query(callExpiry)).rows[0].result.idempotent,true);
    const target = (await db.query("select expires_at::text,activation_policy from public.helix_licenses where id='00000000-0000-4000-8000-000000000102'")).rows[0];
    assert.equal(Date.parse(target.expires_at),Date.parse('2027-04-05T06:07:08.123+00:00'));
    assert.equal(target.activation_policy,'legacy_fixed');
    assert.equal((await db.query("select count(*)::int as count from public.helix_license_events where metadata->>'action'='email_change_expiry_preserved'")).rows[0].count,1);
    assert.equal((await db.query('select count(*)::int as count from public.helix_member_mt5_accounts')).rows[0].count,0,'slot handoff never transfers MT5 ownership');
  } finally { await db.close(); }
});

test('PostgreSQL behavior: account capacity is not divided by five; same account multi-product consumes one slot', { skip: !PGlite && 'Install @electric-sql/pglite transiently to run isolated PostgreSQL behavior checks' }, async () => {
  const claimCondition = /if (v_needs_slot and v_used >= v_capacity) then/.exec(migration)?.[1];
  const downgradeGuard = /if v_after < \(select count\(\*\) from public\.helix_member_mt5_accounts a where a\.member_id=p_member_id and a\.status in \('active','pending_release','suspended','quarantined','unreconciled'\)\) then/.exec(migration)?.[0];
  const usageQuery = /select count\(\*\) into v_used from public\.helix_member_mt5_accounts where member_id=p_member_id and status in \('active','pending_release','suspended','quarantined','unreconciled'\);/.exec(migration)?.[0];
  const allDenied = /not exists\(\s*select 1 from public\.helix_ea_products p where p\.ea_product_id=new\.ea_product_id\s+and p\.enabled and p\.catalog_status='published' and p\.all_access_eligible\s*\)/.exec(migration)?.[0];
  const dedicatedDenied = /not coalesce\(v_pair\.ea_product_id=any\(v_policy\.allowed_products\),false\)/.exec(migration)?.[0];
  assert.ok(claimCondition && downgradeGuard && usageQuery && allDenied && dedicatedDenied, 'must compile exact capacity and entitlement clauses from the staging-validated migration');
  assert.doesNotMatch(migration, /v_used\s*>=\s*v_capacity\s*\/\s*5/);
  assert.doesNotMatch(migration, /v_after\s*<\s*\(select count\(\*\)\*5/);

  const db = new PGlite();
  try {
    await db.exec(`
      create table public.helix_member_mt5_accounts(member_id int, account_id int, status text);
      create table bindings(member_id int, account_id int, license_id text);
      create table sessions(member_id int, account_id int, product text);
      create function can_claim(v_needs_slot boolean,v_used int,v_capacity int)
      returns boolean language plpgsql immutable as $$ begin if ${claimCondition} then return false; else return true; end if; end $$;
      create function can_downgrade(v_after int,p_member_id int) returns boolean
      language plpgsql stable as $$ begin ${downgradeGuard} return false; end if; return true; end $$;
      create function current_usage(p_member_id int) returns int
      language plpgsql stable as $$ declare v_used int; begin ${usageQuery} return v_used; end $$;
      create table catalog(product text primary key, all_access_eligible boolean);
      create table grants(scope text, allowed_products text[]);
      alter table catalog add column enabled boolean not null default true;
      alter table catalog add column catalog_status text not null default 'published';
      create table public.helix_ea_products(ea_product_id text primary key,enabled boolean,catalog_status text,all_access_eligible boolean);
      create function suite_denied(v_pair_product text) returns boolean language sql stable as $$ select ${allDenied.replaceAll('new.ea_product_id','v_pair_product')} $$;
      create function dedicated_denied(v_pair_product text,v_policy_products text[]) returns boolean language sql immutable as $$ select ${dedicatedDenied.replaceAll('v_pair.ea_product_id','v_pair_product').replaceAll('v_policy.allowed_products','v_policy_products')} $$;
      create function allowed(p_scope text,p_products text[],p_product text) returns boolean
      language sql stable as $$ select case when p_scope='helix_suite' then not suite_denied(p_product) when p_scope='product' then not dedicated_denied(p_product,p_products) else false end $$;
      insert into catalog(product,all_access_eligible) values ('A',true),('B',true),('X',false);
      insert into public.helix_ea_products select product,enabled,catalog_status,all_access_eligible from catalog;
      insert into grants values ('helix_suite',array[]::text[]),('product',array['B','D']);
    `);

    for (let used = 0; used < 5; used++) {
      const { rows } = await db.query('select can_claim(true,$1,5) as allowed', [used]);
      assert.equal(rows[0].allowed, true, `capacity 5 should allow account ${used + 1}`);
    }
    assert.equal((await db.query('select can_claim(true,5,5) as allowed')).rows[0].allowed, false, 'sixth account at capacity 5 denied');
    assert.equal((await db.query('select can_claim(true,5,10) as allowed')).rows[0].allowed, true, 'sixth account at capacity 10 allowed');
    assert.equal((await db.query('select can_claim(false,5,5) as allowed')).rows[0].allowed, true, 'existing account may add another license/product without taking a second slot');

    await db.exec(`insert into public.helix_member_mt5_accounts values (1,101,'active');
                  insert into bindings values (1,101,'license-B'),(1,101,'license-D');
                  insert into sessions values (1,101,'B'),(1,101,'D');`);
    assert.equal((await db.query('select current_usage(1) as used')).rows[0].used, 1, 'B+D dedicated licenses share one canonical account slot');
    assert.equal((await db.query('select can_downgrade(1,1) as allowed')).rows[0].allowed, true, 'capacity 1 permits the one canonical account in use');
    assert.equal((await db.query('select can_downgrade(0,1) as allowed')).rows[0].allowed, false, 'cannot downgrade below the one account in use');
    const sessionCount = await db.query('select count(*)::int as products from sessions where member_id=1 and account_id=101');
    assert.equal(sessionCount.rows[0].products, 2, 'both product sessions remain separately represented');
    assert.equal((await db.query("select allowed('helix_suite',array[]::text[],'A') as ok")).rows[0].ok, true, 'legacy suite accepts eligible catalog product with empty array');
    assert.equal((await db.query("select allowed('helix_suite',array[]::text[],'X') as ok")).rows[0].ok, false, 'legacy suite rejects noneligible product');
    assert.equal((await db.query("select allowed('product',array['B','D'],'B') as ok")).rows[0].ok, true, 'B+D grant accepts B');
    assert.equal((await db.query("select allowed('product',array['B','D'],'A') as ok")).rows[0].ok, false, 'B+D grant rejects A');
  } finally {
    await db.close();
  }
});

test('QUADRIGA v1.9c entitlement serializer and legacy fingerprint wire contract are preserved', () => {
  assert.match(migration, /Keep existing helix_suite policy rows intact: the v2 signed entitlement/);
  assert.doesNotMatch(migration, /create or replace function public\.helix_v2_entitlement/i);
  const pairing = readFileSync(new URL('../functions/api/license/v1/pair/start.js', import.meta.url), 'utf8');
  assert.match(pairing, /const fingerprint = await sha256\(`\$\{normalizedServer\}:\$\{login\}`\)/);
  assert.match(migration, /v_policy\.license_scope='product' and not/);
});

test('PostgreSQL executes actual slot adjustment RPC with idempotency, usage guard and serialized first grant', { skip: !PGlite && 'Install @electric-sql/pglite transiently to execute isolated RPC tests' }, async () => {
  const extractFunction = name => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?end \\$\\$;`, 'i').exec(migration)?.[0];
  const adjust = extractFunction('helix_admin_adjust_member_slots');
  const ensure = extractFunction('helix_admin_ensure_member_initial_slots');
  const grandfather = /-- Grandfather existing active accounts[\s\S]*?do \$\$[\s\S]*?LEGACY_ACCOUNT_USAGE_ABOVE_SLOT_MAX[\s\S]*?end \$\$;/.exec(migration)?.[0];
  assert.ok(adjust && ensure && grandfather, 'extract real slot RPCs and legacy cutover block from the staging-validated migration');
  const db = new PGlite();
  try {
    await db.exec(`
      create type public.helix_event_type as enum ('sync');
      create table public.helix_members(id uuid primary key,role text,mt5_slot_capacity int not null default 0,updated_at timestamptz default now());
      create table public.helix_general_settings(setting_key text primary key,setting_value jsonb);
      create table public.helix_licenses(id uuid,member_id uuid,deleted_at timestamptz,created_at timestamptz,status text,expires_at timestamptz);
      create table public.helix_member_mt5_accounts(id uuid default gen_random_uuid(),member_id uuid,status text,account_id int);
      create table public.helix_member_slot_events(id uuid default gen_random_uuid(),member_id uuid,actor_id uuid,event_type text,capacity_delta int,capacity_before int,capacity_after int,idempotency_key uuid unique,reason text,metadata jsonb default '{}'::jsonb,created_at timestamptz default now());
      create table public.helix_license_events(license_id uuid,actor_id uuid,event_type public.helix_event_type,metadata jsonb);
      insert into public.helix_general_settings values('mt5_member_slot_max','10'::jsonb);
      insert into public.helix_members(id,role,mt5_slot_capacity) values('00000000-0000-4000-8000-000000000001','admin',0),('00000000-0000-4000-8000-000000000002','member',0),('00000000-0000-4000-8000-000000000003','member',0),('00000000-0000-4000-8000-000000000004','member',0);
      insert into public.helix_licenses(id,member_id,status,expires_at) values('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000003','active',now()+interval '30 days');
      insert into public.helix_member_mt5_accounts(member_id,status,account_id) values('00000000-0000-4000-8000-000000000003','unreconciled',1),('00000000-0000-4000-8000-000000000003','unreconciled',2),('00000000-0000-4000-8000-000000000003','unreconciled',3),('00000000-0000-4000-8000-000000000003','released',4);
      ${adjust}
      ${ensure}
    `);
    const admin='00000000-0000-4000-8000-000000000001', member='00000000-0000-4000-8000-000000000002';
    const legacy='00000000-0000-4000-8000-000000000003', overLimit='00000000-0000-4000-8000-000000000004';
    await db.exec(grandfather);
    assert.equal((await db.query('select mt5_slot_capacity from public.helix_members where id=$1',[legacy])).rows[0].mt5_slot_capacity,5,'legacy used accounts are grandfathered to one 5-slot package; released history is not charged');
    assert.equal((await db.query("select metadata->>'legacy_accounts' as used from public.helix_member_slot_events where member_id=$1",[legacy])).rows[0].used,'3','legacy capacity reconciliation is audit logged');
    await db.exec("insert into public.helix_licenses(id,member_id,status,expires_at) values('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000004','active',now()+interval '30 days');");
    await db.exec(`insert into public.helix_member_mt5_accounts(member_id,status,account_id) select '${overLimit}','unreconciled',g from generate_series(1,11) g;`);
    await assert.rejects(db.exec(grandfather),/LEGACY_ACCOUNT_USAGE_ABOVE_SLOT_MAX/,'migration must stop when legacy active account usage exceeds configured maximum');
    assert.equal((await db.query('select mt5_slot_capacity from public.helix_members where id=$1',[overLimit])).rows[0].mt5_slot_capacity,0,'over-limit member is not partially grandfathered');
    const [a,b]=await Promise.all([
      db.query("select public.helix_admin_ensure_member_initial_slots($1,$2,$3,$4) as result",[member,admin,'00000000-0000-4000-8000-000000000011','First license slot package']),
      db.query("select public.helix_admin_ensure_member_initial_slots($1,$2,$3,$4) as result",[member,admin,'00000000-0000-4000-8000-000000000012','Second license slot package']),
    ]);
    assert.deepEqual([a.rows[0].result.capacity,b.rows[0].result.capacity].sort(),[5,5], 'two simultaneous first product grants must leave capacity at five, not ten');
    assert.equal((await db.query('select mt5_slot_capacity from public.helix_members where id=$1',[member])).rows[0].mt5_slot_capacity,5);
    const key='00000000-0000-4000-8000-000000000021';
    const first=await db.query("select public.helix_admin_adjust_member_slots($1,$2,5,$3,'admin purchase') as result",[member,admin,key]);
    assert.equal(first.rows[0].result.capacity,10);
    const retry=await db.query("select public.helix_admin_adjust_member_slots($1,$2,5,$3,'admin purchase') as result",[member,admin,key]);
    assert.equal(retry.rows[0].result.idempotent,true);
    const conflict=await db.query("select public.helix_admin_adjust_member_slots($1,$2,10,$3,'different payload') as result",[member,admin,key]);
    assert.equal(conflict.rows[0].result.error_code,'IDEMPOTENCY_CONFLICT');
    await db.exec(`insert into public.helix_member_mt5_accounts(member_id,status,account_id) values ('${member}','active',21),('${member}','pending_release',22),('${member}','released',23);`);
    const downgrade=await db.query("select public.helix_admin_adjust_member_slots($1,$2,-10,'00000000-0000-4000-8000-000000000031','too low') as result",[member,admin]);
    assert.equal(downgrade.rows[0].result.error_code,'SLOT_CAPACITY_BELOW_USAGE');
    assert.equal((await db.query('select mt5_slot_capacity from public.helix_members where id=$1',[member])).rows[0].mt5_slot_capacity,10);
  } finally { await db.close(); }
});
