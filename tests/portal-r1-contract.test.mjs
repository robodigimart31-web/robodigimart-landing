import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
import { onRequestPost as pairStart } from '../functions/api/license/v1/pair/start.js';
import { onRequestPost as pairPoll } from '../functions/api/license/v1/pair/poll.js';
import { onRequestPost as telemetry } from '../functions/api/telemetry/v1/deals.js';
import { onRequestGet as portalStatus } from '../functions/api/portal/v1/status.js';
import { onRequest as vipApi } from '../functions/vip/api/[[path]].js';
import { onRequest as vipHostRouting } from '../functions/_middleware.js';

const secret = 'local-test-only-pairing-secret-32-bytes-minimum';

test('pair start returns a short code and independent secret while persisting only proof hashes', async t => {
  let inserted;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes('helix_rate_limit')) return Response.json({ allowed: true });
    if (String(url).includes('helix_pairing_start')) { inserted = body; return Response.json({ id: 'request-id', expires_at: '2026-10-11T12:10:00Z' }); }
    throw new Error('Unexpected backend request');
  });
  const request = new Request('https://local.test/api/license/v1/pair/start', { method: 'POST', headers: { 'content-type':'application/json', origin:'https://www.robodigimart.com' }, body: JSON.stringify({ broker_server:'Demo Broker-Server', account_login:'12345678', mode:'demo' }) });
  const response = await pairStart({ request, env: { SUPABASE_URL:'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY:'local-test-key', PAIRING_HASH_SECRET:secret, PORTAL_OTP_ENABLED:'true' } });
  assert.equal(response.status, 201);
  const output = await response.json();
  assert.match(output.pairing_code, /^\d{8}$/);
  assert.ok(output.session_secret.length >= 40);
  assert.equal(inserted.p_session_hash.length,64);
  assert.equal(inserted.p_code_hash.length,64);
  assert.notEqual(inserted.p_session_hash,output.session_secret);
  assert.notEqual(inserted.p_code_hash,output.pairing_code);
  assert.equal(JSON.stringify(inserted).includes(output.session_secret),false);
  assert.equal(JSON.stringify(inserted).includes(output.pairing_code),false);
});

test('pair start enforces atomic rate limit response', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ allowed:false, retry_after_seconds:90 }));
  const request = new Request('https://local.test/api/license/v1/pair/start', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker_server:'Demo Server',account_login:'12345678',mode:'demo'}) });
  const response = await pairStart({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key',PAIRING_HASH_SECRET:secret,PORTAL_OTP_ENABLED:'true'}});
  assert.equal(response.status,429);
  assert.equal((await response.json()).retry_after_seconds,90);
});

test('production portal flags default closed and performance requires explicit R7 verification', async () => {
  const response=await portalStatus({env:{}});
  const payload=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(payload.features,{license_management:false,otp_pairing:false,email_change:false,trading_performance:false});
  const r7=await portalStatus({env:{PORTAL_PERFORMANCE_ENABLED:'true'}});
  assert.equal((await r7.json()).features.trading_performance,false);
});

test('OTP start stays disabled without database calls until owner activates flag', async t => {
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must remain disabled')});
  const request=new Request('https://local.test/api/license/v1/pair/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker_server:'Demo Server',account_login:'12345678',mode:'demo'})});
  const response=await pairStart({request,env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}});
  assert.equal(response.status,503);assert.equal((await response.json()).feature,'otp_pairing');assert.equal(calls,0);
});

test('disabled performance ingest does not call the database even with a session proof', async t => {
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must remain disabled')});
  const request=new Request('https://local.test/api/telemetry/v1/deals',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'a'.repeat(48)},body:JSON.stringify({deals:[{}]})});
  const response=await telemetry({request,env:{SUPABASE_SERVICE_ROLE_KEY:'test'}});
  assert.equal(response.status,503);assert.equal((await response.json()).feature,'trading_performance');assert.equal(calls,0);
});

test('member role cannot enter admin API when license features are enabled', async t => {
  const memberId='00000000-0000-4000-8000-000000000002';
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('/auth/v1/user')?Response.json({id:memberId}):Response.json([{id:memberId,email:'member@test.invalid',display_name:'Test',role:'member'}]));
  const request=new Request('https://local.test/vip/api/admin/licenses',{method:'POST',headers:{authorization:'Bearer local-user-token','content-type':'application/json'},body:'{}'});
  const response=await vipApi({request,env:{PORTAL_LICENSE_MANAGEMENT_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'local-test-key'}});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'Akses admin diperlukan.');
});

test('pair poll and telemetry reject missing session proof before database access', async t => {
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not call db')});
  const request = new Request('https://local.test/api', {method:'POST',headers:{'content-type':'application/json',origin:'https://www.robodigimart.com'},body:'{}'});
  assert.equal((await pairPoll({request,env:{}})).status,401);
  assert.equal((await telemetry({request,env:{}})).status,401);
  assert.equal(calls,0);
});

test('all portal inline scripts parse and the existing 7/5 menu inventory remains', async () => {
  for (const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/login.html','public/vip/login/index.html']) {
    const html=await readFile(path,'utf8');let count=0;
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1],{filename:path+':inline'+(++count)});
  }
  const member=await readFile('public/vip/index.html','utf8'),admin=await readFile('public/vip/admin/index.html','utf8');
  assert.equal((member.match(/\['(?:dashboard|licenses|accounts|activity|announcements|materials|profile)'/g)||[]).length,7);
  assert.equal((admin.match(/\['(?:Dashboard|Member|License|Announcement|Material)'/g)||[]).length,5);
});

test('R1 UI scripts parse and shipped assets exist', async () => {
  for (const path of ['public/vip/helix-ui/js/portal-r1.js','public/vip/helix-ui/js/portal-r1-loader.js']) new vm.Script(await readFile(path,'utf8'),{filename:path});
  for (const path of ['public/vip/helix-ui/css/tokens.css','public/vip/helix-ui/css/components.css','public/vip/helix-ui/css/portal-adapter.css','public/vip/helix-ui/css/portal-r1.css','public/vip/helix-ui/backgrounds/mountain-hero.webp','public/vip/helix-ui/backgrounds/mountain-sidebar.webp','public/vip/helix-ui/icons/home.svg','public/vip/helix-ui/icons/key.svg']) await access(path);
});

test('license create response never returns a key or key hash', async () => {
  const sql=await readFile('supabase/migrations/202610110001_helix_otp_telemetry.sql','utf8');
  const api=await readFile('functions/vip/api/[[path]].js','utf8');
  assert.match(sql,/jsonb_build_object\('id',v_license\.id,'member_id',v_license\.member_id/);
  assert.doesNotMatch(sql,/jsonb_build_object\([^\n]*license_key_hash/);
  assert.match(api,/"helix_admin_create_license"/);
  assert.doesNotMatch(api,/response\(\{[^\n]*license_key\s*:/);
  const browser=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8');
  assert.doesNotMatch(browser,/SUPABASE_SERVICE_ROLE_KEY|LICENSE_SIGNING_PRIVATE_KEY_PKCS8|PAIRING_HASH_SECRET/);
});

test('released binding reactivation in OTP and legacy licensing paths enforces slot cap and revokes old sessions', async () => {
  const sql=await readFile('supabase/migrations/202610110001_helix_otp_telemetry.sql','utf8');
  const production=await readFile('PRODUCTION_READY/02_PRODUCTION_MIGRATION.sql','utf8');
  for (const source of [sql,production]) {
    const approve=source.slice(source.indexOf('create or replace function public.helix_pairing_approve'),source.indexOf('create or replace function public.helix_pairing_poll'));
    assert.match(approve,/if v_binding\.released_at is not null then[\s\S]*select count\(\*\) into v_slots[\s\S]*if v_slots>=v_license\.max_accounts then return jsonb_build_object\('ok',false,'error_code','ACCOUNT_LIMIT_REACHED'\)/);
    assert.match(approve,/update public\.helix_license_sessions set revoked_at=coalesce\(revoked_at,v_now\)[\s\S]*where binding_id=v_binding\.id/);
    assert.match(approve,/binding_reactivated',v_reactivated/);
    const legacy=source.slice(source.indexOf('create or replace function public.helix_touch_binding'),source.indexOf('\ndo $$ declare f text;'));
    assert.match(legacy,/if v_binding\.released_at is not null then[\s\S]*if v_count>=v_license\.max_accounts then raise exception 'Account slot limit reached'/);
    assert.match(legacy,/update public\.helix_license_sessions set revoked_at=coalesce\(revoked_at,now\(\)\)[\s\S]*where binding_id=v_binding\.id/);
    assert.match(legacy,/binding_reactivated',v_reactivated/);
    assert.match(legacy,/values\(p_license,p_server,p_login,v_fp,p_mode\)/);
  }
  assert.equal(sql.slice(sql.indexOf('create or replace function public.helix_pairing_approve'),sql.indexOf('create or replace function public.helix_pairing_poll')),
    production.slice(production.indexOf('create or replace function public.helix_pairing_approve'),production.indexOf('create or replace function public.helix_pairing_poll')));
});

test('VIP subdomain maps root and existing shortcut routes to the live portal shell', async () => {
  for (const [path, expected] of [['/','/vip/'],['/admin','/vip/admin/'],['/login','/vip/login/'],['/reset-password','/vip/reset-password/']]) {
    let forwarded;
    const request=new Request(`https://vipmember.robodigimart.com${path}?flow=invite`);
    const response=await vipHostRouting({request,next:async value=>{forwarded=value||request;return Response.json({url:forwarded.url});}});
    assert.equal(response.status,200);
    assert.equal(new URL((await response.json()).url).pathname,expected);
    assert.equal(new URL(forwarded.url).searchParams.get('flow'),'invite');
  }
  const request=new Request('https://www.robodigimart.com/');let forwarded=request;
  await vipHostRouting({request,next:async value=>{forwarded=value||request;return new Response('ok');}});
  assert.equal(forwarded.url,request.url,'main website host is not rewritten');
});
