import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequest as vipApi } from '../functions/vip/api/[[path]].js';

const member='00000000-0000-4000-8000-000000000021';
const license='00000000-0000-4000-8000-000000000022';

test('member portal query retains active and pending bindings plus released history younger than a calendar month', async t => {
  let bindingQuery='';
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const value=String(url);
    if(value.includes('/auth/v1/user'))return Response.json({id:member});
    if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);
    if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:member,email:'member@test.invalid',display_name:'Member',role:'member'}]);
    if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:member,product_slug:'quadriga',status:'active',expires_at:'2028-10-10T00:00:00Z',license_key_hint:'••1234',max_accounts:5}]);
    if(value.includes('/rest/v1/helix_license_bindings?')){bindingQuery=value;return Response.json([{id:'active',license_id:license,released_at:null,release_state:'active'},{id:'pending',license_id:license,released_at:null,release_state:'pending_release',release_request_id:'00000000-0000-4000-8000-000000000023'},{id:'released-recent',license_id:license,released_at:new Date().toISOString(),release_state:'released'}]);}
    if(value.includes('/rest/v1/helix_announcements?')||value.includes('/rest/v1/helix_materials?')||value.includes('/rest/v1/helix_license_events?'))return Response.json([]);
    if(value.includes('/rest/v1/helix_email_change_requests?'))return Response.json([]);
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request('https://local.test/vip/api/member',{headers:{authorization:'Bearer member-session'}});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key',PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});
  const data=await response.json();
  assert.equal(response.status,200);
  assert.match(bindingQuery,/or=\(released_at\.is\.null,released_at\.gte\./);
  assert.equal(data.bindings.length,3);
  assert.equal(data.bindings.find(x=>x.id==='pending').binding_status,'PENDING RELEASE');
  assert.equal(data.bindings.find(x=>x.id==='released-recent').binding_status,'RELEASED');
});

test('released bindings are hidden only from dashboard; pending release remains visible and MT5 Accounts keeps recent history', async () => {
  const ui=await readFile('public/vip/index.html','utf8');
  const api=await readFile('functions/vip/api/[[path]].js','utf8');
  assert.match(ui,/accountTable\(false\)/);
  assert.match(ui,/function accountTable\(includeReleased=true\)/);
  assert.match(ui,/status==='PENDING RELEASE'/);
  assert.match(ui,/riwayat release/);
  assert.match(ui,/HELIX tidak menjanjikan profit\./);
  assert.doesNotMatch(ui,/Penggunaan EA HELIX tidak selalu menghasilkan keuntungan/);
  assert.match(api,/const retentionFilter = releaseAckV18k \? `or=\(released_at\.is\.null,released_at\.gte\./);
  assert.match(api,/const retentionFilter = releaseAckV18k[\s\S]*?supabase\(env, `helix_license_bindings\?\$\{retentionFilter\}/);
});

test('retention migration purges only released bindings after one calendar month and preserves license audit events', async () => {
  const sql=await readFile('supabase/migrations/202610130002_helix_released_binding_retention.sql','utf8');
  assert.match(sql,/create extension if not exists pg_cron/);
  assert.match(sql,/b\.release_state='released'[\s\S]*b\.released_at < now\(\)-interval '1 month'/);
  assert.match(sql,/s\.binding_id=b\.id and s\.revoked_at is null/);
  assert.match(sql,/update public\.helix_license_events[\s\S]*set binding_id=null/);
  assert.match(sql,/cron\.schedule\([\s\S]*'15 2 \* \* \*'[\s\S]*helix_purge_released_bindings_after_one_month/);
  assert.doesNotMatch(sql,/delete from public\.helix_licenses/);
});
