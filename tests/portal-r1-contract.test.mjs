import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { onRequestPost as pairStart } from '../functions/api/license/v1/pair/start.js';
import { onRequestPost as pairPoll } from '../functions/api/license/v1/pair/poll.js';
import { onRequestPost as licenseSync } from '../functions/api/license/v1/sync.js';
import { onRequestPost as releaseAck } from '../functions/api/license/v1/release/ack.js';
import { onRequestPost as telemetry, performanceWindowStart as telemetryWindowStart } from '../functions/api/telemetry/v1/deals.js';
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
  const request = new Request('https://local.test/api/license/v1/pair/start', { method: 'POST', headers: { 'content-type':'application/json', origin:'https://www.robodigimart.com' }, body: JSON.stringify({ broker_server:'Demo Broker-Server', account_login:'12345678', mode:'demo', protocol_version:'v2', ea_build:'unit-test', ea_product_id:'quadriga', ea_version:'1.8c' }) });
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
  assert.equal(Object.hasOwn(inserted,'p_registry_fingerprint'),false,'public EA pairing start must not mint/attach a member-owned HMAC registry identity');
});

test('pair start enforces atomic rate limit response', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ allowed:false, retry_after_seconds:90 }));
  const request = new Request('https://local.test/api/license/v1/pair/start', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker_server:'Demo Server',account_login:'12345678',mode:'demo'}) });
  const response = await pairStart({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key',PAIRING_HASH_SECRET:secret,PORTAL_OTP_ENABLED:'true'}});
  assert.equal(response.status,429);
  assert.equal((await response.json()).retry_after_seconds,90);
});

test('v1.8k sync remains gated from legacy clients and advertises 15 minute retry on the staged path', async t => {
  let calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{const value=String(url);if(value.includes('/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rpc/helix_license_sync_v18k')){calls.push('v18k');return Response.json({state:'PENDING_RELEASE',release_id:'11111111-1111-4111-8111-111111111111',server_time:'2026-10-12T10:00:00Z'})}if(value.includes('/rpc/helix_license_sync')){calls.push('legacy');return Response.json({state:'REVOKED',error_code:'SESSION_REVOKED'})}throw new Error(`Unexpected request: ${url}`)});
  const request=()=>new Request('https://local.test/api/license/v1/sync',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:'{}'});
  const disabled=await licenseSync({request:request(),env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret,PORTAL_OTP_ENABLED:'true'}});
  assert.equal(disabled.status,403);assert.deepEqual(calls,['legacy']);
  const response=await licenseSync({request:request(),env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret,PORTAL_OTP_ENABLED:'true',PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});
  const body=await response.json();assert.equal(response.status,200);assert.deepEqual(calls,['legacy','v18k']);assert.equal(body.next_sync_seconds,900);assert.equal(body.release_id,'11111111-1111-4111-8111-111111111111');
});

test('v1.8k active renewal returns a signed entitlement with a maximum 120 minute offline deadline', async t => {
  const pair=await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const privateKey=Buffer.from(await webcrypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
  const entitlement={protocol_version:'v2',license_scope:'product',license_id:'11111111-1111-4111-8111-111111111111',binding_id:'22222222-2222-4222-8222-222222222222',account_fingerprint:'a'.repeat(64),status:'ACTIVE',license_expires_at:'2028-10-10T00:00:00Z',entitlement_version:2,ea_product_id:'quadriga',ea_version:'1.8k',allowed_products:['quadriga'],issued_at:'2026-10-12T10:00:00Z',server_time:'2026-10-12T10:00:00Z',offline_expires_at:'2026-10-12T12:00:00Z'};
  t.mock.method(globalThis,'fetch',async(url,options)=>{const value=String(url);if(value.includes('/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rpc/helix_license_sync_v18k'))return Response.json({state:'ACTIVE',server_time:'2026-10-12T10:00:00Z',entitlement});throw new Error(`Unexpected request: ${url}`)});
  const request=new Request('https://local.test/api/license/v1/sync',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:'{}'});
  const response=await licenseSync({request,env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret,PORTAL_OTP_ENABLED:'true',PORTAL_LICENSE_RELEASE_ACK_V18K:'true',LICENSE_SIGNING_PRIVATE_KEY_PKCS8:privateKey}});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.state,'ACTIVE');assert.equal(body.next_sync_seconds,900);assert.equal(body.retry_after_seconds,900);assert.equal(body.offline_grace_hours,2);assert.ok(body.entitlement.signature);assert.equal(Date.parse(body.entitlement.payload.offline_expires_at)-Date.parse(body.entitlement.payload.server_time),120*60_000);
});

test('v1.8k sync returns PENDING_RELEASE as a successful stop signal and does not sign ACTIVE entitlement', async t => {
  t.mock.method(globalThis,'fetch',async url=>{const value=String(url);if(value.includes('/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rpc/helix_license_sync_v18k'))return Response.json({state:'PENDING_RELEASE',release_id:'11111111-1111-4111-8111-111111111111',server_time:'2026-10-12T10:00:00Z'});throw new Error(`Unexpected request: ${url}`)});
  const request=new Request('https://local.test/api/license/v1/sync',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:'{}'});
  const response=await licenseSync({request,env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret,PORTAL_OTP_ENABLED:'true',PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.state,'PENDING_RELEASE');assert.equal(body.next_sync_seconds,900);assert.equal(body.release_id,'11111111-1111-4111-8111-111111111111');assert.equal(body.entitlement,undefined);
});

test('v1.8k release ACK requires feature flag, session proof, release id, and clean pending orders; released ACK is idempotent', async t => {
  let ackArgs;
  t.mock.method(globalThis,'fetch',async(url,options)=>{const value=String(url);if(value.includes('/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rpc/helix_release_ack_v18k')){ackArgs=JSON.parse(options.body);return Response.json({ok:true,state:'RELEASED',release_id:ackArgs.p_release_id,idempotent:true,released_at:'2026-10-12T10:00:00Z'})}throw new Error(`Unexpected request: ${url}`)});
  const makeRequest=(body,authorization='Bearer '+secret)=>new Request('https://local.test/api/license/v1/release/ack',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body)});
  const off=await releaseAck({request:makeRequest({release_id:'11111111-1111-4111-8111-111111111111',pending_orders_clean:true}),env:{SUPABASE_SERVICE_ROLE_KEY:'test'}});assert.equal(off.status,503);
  const noProof=await releaseAck({request:makeRequest({release_id:'11111111-1111-4111-8111-111111111111',pending_orders_clean:true},''),env:{SUPABASE_SERVICE_ROLE_KEY:'test',PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});assert.equal(noProof.status,401);
  const dirty=await releaseAck({request:makeRequest({release_id:'11111111-1111-4111-8111-111111111111',pending_orders_clean:false}),env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret,PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});assert.equal(dirty.status,422);
  const response=await releaseAck({request:makeRequest({release_id:'11111111-1111-4111-8111-111111111111',pending_orders_clean:true}),env:{SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret,PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.state,'RELEASED');assert.equal(body.idempotent,true);assert.equal(ackArgs.p_pending_orders_clean,true);assert.equal(ackArgs.p_release_id,'11111111-1111-4111-8111-111111111111');assert.equal(ackArgs.p_session_hash.length,64);
});

test('v1.8k SQL keeps release pending until every non-revoked binding session ACKs and audits force release', async () => {
  const sql=await readFile('supabase/migrations/202610130001_helix_license_release_ack_v18k.sql','utf8');
  assert.match(sql,/release_state in \('active','pending_release','released'\)/);
  assert.match(sql,/state','PENDING_RELEASE'[\s\S]*slot_retained',true/);
  assert.match(sql,/select count\(\*\) into v_required from public\.helix_license_sessions where binding_id=v_binding\.id and revoked_at is null/);
  assert.match(sql,/if v_required=0 or v_acked<v_required then return jsonb_build_object\('ok',true,'state','PENDING_RELEASE'/);
  assert.match(sql,/release_ack_orders_clean is true/);
  assert.match(sql,/update public\.helix_license_bindings set release_state='released',released_at=v_now/);
  assert.match(sql,/ADMIN_REQUIRED/);assert.match(sql,/action','admin_force_release/);assert.match(sql,/warning_acknowledged',true/);
  assert.match(sql,/revoke all on function public\.%s from public,anon,authenticated/);assert.match(sql,/grant execute on function public\.%s to service_role/);
});

test('production portal flags default closed and performance requires explicit R7 verification', async () => {
  const response=await portalStatus({env:{}});
  const payload=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(payload.features,{license_management:false,otp_pairing:false,license_release_ack_v18k:false,email_change:false,trading_performance:false,trading_performance_canary:false});
  const staged=await portalStatus({env:{PORTAL_LICENSE_RELEASE_ACK_V18K:'true'}});assert.equal((await staged.json()).readiness.license_release_ack_v18k,'enabled');
  const r7=await portalStatus({env:{PORTAL_PERFORMANCE_ENABLED:'true'}});
  assert.equal((await r7.json()).features.trading_performance,false);
});

test('email-change production flag is enabled while preview remains closed', async () => {
  const config=JSON.parse((await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8')));
  assert.equal(config.env.production.vars.PORTAL_EMAIL_CHANGE_ENABLED,'true');
  assert.equal(config.env.preview.vars.PORTAL_EMAIL_CHANGE_ENABLED,'false');
});

test('manual email-change approval UI collects a name and sends invitation from the request queue', async () => {
  const ui=await readFile(new URL('../public/vip/helix-ui/js/portal-r1.js',import.meta.url),'utf8');
  assert.match(ui,/data-r1-email-approve/);assert.match(ui,/data-email="\$\{esc\(r\.new_email\)\}"/);
  assert.match(ui,/Kirim invitation email baru/);assert.match(ui,/action:'approve',email:button\.dataset\.email,display_name/);
  assert.match(ui,/window\.addEventListener\('click'/);
});

test('admin email-change approval provisions new email/license before suspending the old account', async t => {
  const actor='00000000-0000-4000-8000-000000000101',oldMember='00000000-0000-4000-8000-000000000102',newMember='00000000-0000-4000-8000-000000000103',requestId='00000000-0000-4000-8000-000000000104';
  const events=[];let licenseArgs;
  t.mock.method(globalThis,'fetch',async(input,options={})=>{
    const url=new URL(String(input)),path=url.pathname,body=options.body?JSON.parse(options.body):null;
    if(path==='/auth/v1/user')return Response.json({id:actor});
    if(path==='/rest/v1/helix_members'&&url.searchParams.get('id')===`eq.${actor}`)return Response.json([{id:actor,email:'admin@example.test',display_name:'Admin',role:'admin'}]);
    if(path==='/rest/v1/helix_member_suspensions')return Response.json([]);
    if(path==='/rest/v1/helix_email_change_requests'&&url.searchParams.has('id'))return Response.json([{id:requestId,member_id:oldMember,new_email:'new@example.test',status:'pending'}]);
    if(path==='/rest/v1/helix_members'&&url.searchParams.has('email'))return Response.json([]);
    if(path==='/auth/v1/invite'){events.push('invite');assert.equal(body.email,'new@example.test');return Response.json({user:{id:newMember,email:body.email}})}
    if(path==='/rest/v1/helix_members'&&url.searchParams.get('id')===`eq.${newMember}`)return Response.json([{id:newMember,email:'new@example.test'}]);
    if(path==='/rest/v1/rpc/helix_admin_create_license'){events.push('license');licenseArgs=body;return Response.json({ok:true,license:{id:'license-new'}})}
    if(path==='/rest/v1/rpc/helix_admin_set_member_suspended'){events.push('suspend');return Response.json({ok:true,licenses_changed:1,sessions_revoked:true})}
    if(path===`/auth/v1/admin/users/${oldMember}`&&options.method==='PUT'){events.push('auth-ban');return Response.json({id:oldMember})}
    if(path==='/rest/v1/rpc/helix_email_change_complete'){events.push('complete');return Response.json({ok:true,status:'completed',member_id:oldMember,new_email:'new@example.test'})}
    throw new Error(`Unexpected request ${options.method||'GET'} ${url}`);
  });
  const request=new Request(`https://local.test/vip/api/admin/email-change-requests/${requestId}`,{method:'POST',headers:{authorization:'Bearer admin-session','content-type':'application/json'},body:JSON.stringify({action:'approve',email:'new@example.test',display_name:'New Member'})});
  const result=await vipApi({request,env:{SUPABASE_URL:'https://supabase.test',SUPABASE_SERVICE_ROLE_KEY:'test-service-key',PORTAL_EMAIL_CHANGE_ENABLED:'true'}});
  assert.equal(result.status,200,JSON.stringify(await result.clone().json()));assert.equal((await result.json()).status,'completed');assert.deepEqual(events,['invite','license','suspend','auth-ban','complete']);
  assert.equal(licenseArgs.p_idempotency_key,requestId);assert.equal(licenseArgs.p_member_id,newMember);
});

test('failed invite-license creation keeps the old account active and the request pending', async t => {
  const actor='00000000-0000-4000-8000-000000000111',oldMember='00000000-0000-4000-8000-000000000112',newMember='00000000-0000-4000-8000-000000000113',requestId='00000000-0000-4000-8000-000000000114';
  const events=[];
  t.mock.method(globalThis,'fetch',async(input,options={})=>{
    const url=new URL(String(input)),path=url.pathname,body=options.body?JSON.parse(options.body):null;
    if(path==='/auth/v1/user')return Response.json({id:actor});
    if(path==='/rest/v1/helix_members'&&url.searchParams.get('id')===`eq.${actor}`)return Response.json([{id:actor,email:'admin@example.test',display_name:'Admin',role:'admin'}]);
    if(path==='/rest/v1/helix_member_suspensions')return Response.json([]);
    if(path==='/rest/v1/helix_email_change_requests'&&url.searchParams.has('id'))return Response.json([{id:requestId,member_id:oldMember,new_email:'new@example.test',status:'pending'}]);
    if(path==='/rest/v1/helix_members'&&url.searchParams.has('email'))return Response.json([]);
    if(path==='/auth/v1/invite'){events.push('invite');return Response.json({user:{id:newMember,email:body.email}})}
    if(path==='/rest/v1/helix_members'&&url.searchParams.get('id')===`eq.${newMember}`)return Response.json([{id:newMember,email:'new@example.test'}]);
    if(path==='/rest/v1/rpc/helix_admin_create_license'){events.push('license');return Response.json({ok:false,error_code:'LICENSE_CREATE_FAILED'})}
    if(path==='/rest/v1/rpc/helix_admin_set_member_suspended'){events.push('suspend');return Response.json({ok:true})}
    throw new Error(`Unexpected request ${options.method||'GET'} ${url}`);
  });
  const request=new Request(`https://local.test/vip/api/admin/email-change-requests/${requestId}`,{method:'POST',headers:{authorization:'Bearer admin-session','content-type':'application/json'},body:JSON.stringify({action:'approve',email:'new@example.test',display_name:'New Member'})});
  const result=await vipApi({request,env:{SUPABASE_URL:'https://supabase.test',SUPABASE_SERVICE_ROLE_KEY:'test-service-key',PORTAL_EMAIL_CHANGE_ENABLED:'true'}});
  assert.equal(result.status,503);assert.equal((await result.json()).error,'LICENSE_CREATE_FAILED');assert.deepEqual(events,['invite','license']);
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

test('global telemetry forwards only schema-validated deals to server validation with global entitlement', async t => {
  let ingestArgs;
  t.mock.method(globalThis,'fetch',async (url,options)=>{const value=String(url);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/rpc/helix_ingest_telemetry_deals_v2')){ingestArgs=JSON.parse(options.body);return Response.json({ok:true,accepted:1,updated_trades:1,synced_at:'2026-10-12T10:00:00Z'})}throw new Error(`Unexpected request: ${url}`)});
  const deal={deal_ticket:'12345',position_id:'54321',occurred_at_broker:'2026-10-12T10:00:00',direction:'BUY',entry_kind:'IN',volume:0.1,profit:0,commission:0,swap:0,fee:0,currency:'USD',symbol:'EURUSD',magic:681001};
  const request=new Request('https://local.test/api/telemetry/v1/deals',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'a'.repeat(48)},body:JSON.stringify({schema_version:'2-broker-time',time_basis:'BROKER_SERVER',magic_base:681000,deals:[deal]})});
  const response=await telemetry({request,env:{PORTAL_PERFORMANCE_ENABLED:'true',EA_R7_TELEMETRY_READY:'true',PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.accepted,1);assert.equal(ingestArgs.p_global_enabled,true);assert.equal(ingestArgs.p_magic_base,681000);assert.equal(ingestArgs.p_deals[0].deal_ticket,'12345');
});

test('telemetry retention is capped at six rolling months with the HELIX launch date as the floor', () => {
  assert.equal(telemetryWindowStart(new Date('2026-10-12T00:00:00Z')),'2026-09-01');
  assert.equal(telemetryWindowStart(new Date('2027-04-01T00:00:00Z')),'2026-10-01');
  assert.equal(telemetryWindowStart(new Date('2027-05-01T00:00:00Z')),'2026-11-01');
});

test('member role cannot enter admin API when license features are enabled', async t => {
  const memberId='00000000-0000-4000-8000-000000000002';
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('/auth/v1/user')?Response.json({id:memberId}):String(url).includes('/helix_member_suspensions?')?Response.json([]):Response.json([{id:memberId,email:'member@test.invalid',display_name:'Test',role:'member'}]));
  const request=new Request('https://local.test/vip/api/admin/licenses',{method:'POST',headers:{authorization:'Bearer local-user-token','content-type':'application/json'},body:'{}'});
  const response=await vipApi({request,env:{PORTAL_LICENSE_MANAGEMENT_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'local-test-key'}});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'Akses admin diperlukan.');
});

test('member role changes require a verified admin and call the audited role RPC with server actor identity', async t => {
  const actor='00000000-0000-4000-8000-000000000010',target='00000000-0000-4000-8000-000000000011';let rpcArgs;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    if(String(url).includes('/auth/v1/user'))return Response.json({id:actor});
    if(String(url).includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);
    if(String(url).includes('/rest/v1/helix_members?'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);
    if(String(url).includes('/rest/v1/rpc/helix_admin_set_member_role')){rpcArgs=JSON.parse(options.body);return Response.json({ok:true,role:'admin'});}
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request(`https://local.test/vip/api/admin/members/${target}/role`,{method:'PATCH',headers:{authorization:'Bearer admin-session','content-type':'application/json'},body:JSON.stringify({role:'admin',reason:'Approved for operations'})});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'test-service-key'}});
  assert.equal(response.status,200);assert.deepEqual(rpcArgs,{p_target_member_id:target,p_actor_id:actor,p_role:'admin',p_reason:'Approved for operations'});
});

test('members can update only their own validated profile display name', async t => {
  const memberId='00000000-0000-4000-8000-000000000012';let saved;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    if(String(url).includes('/auth/v1/user'))return Response.json({id:memberId});
    if(String(url).includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);
    if(String(url).includes('/rest/v1/helix_members?')){
      if(options.method==='PATCH'){saved=JSON.parse(options.body);return Response.json([{id:memberId,email:'member@test.invalid',display_name:saved.display_name,role:'member'}]);}
      return Response.json([{id:memberId,email:'member@test.invalid',display_name:'Old Name',role:'member'}]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request('https://local.test/vip/api/member/profile',{method:'PATCH',headers:{authorization:'Bearer member-session','content-type':'application/json'},body:JSON.stringify({display_name:'  New   Member  '})});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key'}});
  assert.equal(response.status,200);assert.equal(saved.display_name,'New Member');assert.equal((await response.json()).member.display_name,'New Member');
});

test('member portal API refuses a still-valid Auth session after the database suspension marker is set', async t => {
  const memberId='00000000-0000-4000-8000-000000000015';
  t.mock.method(globalThis,'fetch',async url=>{
    const value=String(url);
    if(value.includes('/auth/v1/user'))return Response.json({id:memberId});
    if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:memberId,email:'member@test.invalid',display_name:'Member',role:'member'}]);
    if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([{member_id:memberId}]);
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request('https://local.test/vip/api/member',{headers:{authorization:'Bearer existing-valid-jwt'}});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key'}});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'MEMBER_SUSPENDED');
});

test('pre-migration portal remains available when the suspension marker table is not installed yet', async t => {
  const memberId='00000000-0000-4000-8000-000000000016';
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const value=String(url);
    if(value.includes('/auth/v1/user'))return Response.json({id:memberId});
    if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json({code:'PGRST205'},{status:404});
    if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:memberId,email:'member@test.invalid',display_name:'Member',role:'member'}]);
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request('https://local.test/vip/api/member/profile',{method:'PATCH',headers:{authorization:'Bearer existing-valid-jwt','content-type':'application/json'},body:JSON.stringify({display_name:'Updated Name'})});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key'}});
  assert.equal(response.status,200);
});

test('member and admin UI expose self name changes and use HELIX TEAM wording', async () => {
  const member=await readFile('public/vip/index.html','utf8'),admin=await readFile('public/vip/admin/index.html','utf8'),api=await readFile('functions/vip/api/[[path]].js','utf8');
  assert.match(member,/data-edit-profile-name/);assert.match(member,/member\/profile/);assert.match(admin,/id="edit-own-name"/);assert.match(admin,/member\/profile/);
  for(const source of [member,admin,api]){assert.match(source,/HELIX TEAM/);assert.doesNotMatch(source,/Supabase Auth/);}
});

test('member suspend blocks license sessions through the restricted RPC before banning portal login', async t => {
  const actor='00000000-0000-4000-8000-000000000013',target='00000000-0000-4000-8000-000000000014';const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const value=String(url);
    if(value.includes('/auth/v1/user'))return Response.json({id:actor});
    if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);
    if(value.includes('/rest/v1/helix_members?'))return Response.json(value.includes(`id=eq.${actor}`)?[{id:actor,email:'admin@test.invalid',display_name:'Admin',role:'admin'}]:[{id:target,role:'member'}]);
    if(value.includes('/rest/v1/rpc/helix_admin_set_member_suspended')){calls.push(['license',JSON.parse(options.body)]);return Response.json({ok:true,licenses_changed:1,sessions_revoked:true});}
    if(value.includes('/auth/v1/admin/users/')){calls.push(['auth',JSON.parse(options.body)]);return Response.json({id:target});}
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request(`https://local.test/vip/api/admin/members/${target}`,{method:'POST',headers:{authorization:'Bearer admin-session','content-type':'application/json'},body:JSON.stringify({action:'suspend',reason:'Policy violation'})});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key'}});
  assert.equal(response.status,200);assert.deepEqual(calls.map(x=>x[0]),['license','auth']);assert.equal(calls[0][1].p_member_id,target);assert.equal(calls[0][1].p_actor_id,actor);assert.equal(calls[0][1].p_suspended,true);assert.equal(calls[1][1].ban_duration,'876000h');
});

test('member suspension migration revokes sessions, snapshots active licenses, and protects the RPC', async () => {
  const sql=await readFile('supabase/migrations/202610110003_helix_member_license_suspend.sql','utf8');
  assert.match(sql,/helix_member_license_suspensions/);assert.match(sql,/set status='suspended',entitlement_version/);assert.match(sql,/set revoked_at=coalesce\(s\.revoked_at/);assert.match(sql,/set status=x\.prior_status/);assert.match(sql,/revoke all on function public\.helix_admin_set_member_suspended[\s\S]*grant execute[\s\S]*service_role/);
});

test('role change rejects member callers and blocks self role changes before RPC', async t => {
  const actor='00000000-0000-4000-8000-000000000010',target='00000000-0000-4000-8000-000000000011';let rpcCalls=0;
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('/auth/v1/user')?Response.json({id:actor}):Response.json([{id:actor,email:'test@test.invalid',role:'member'}]));
  const memberRequest=new Request(`https://local.test/vip/api/admin/members/${target}/role`,{method:'PATCH',headers:{authorization:'Bearer member-session','content-type':'application/json'},body:JSON.stringify({role:'admin',reason:'Approved'})});
  assert.equal((await vipApi({request:memberRequest,env:{SUPABASE_SERVICE_ROLE_KEY:'test'}})).status,403);
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async (url,options)=>{if(String(url).includes('/auth/v1/user'))return Response.json({id:actor});if(String(url).includes('/rest/v1/helix_members?'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);if(String(url).includes('/rpc/helix_admin_set_member_role'))rpcCalls++;return Response.json([])});
  const selfRequest=new Request(`https://local.test/vip/api/admin/members/${actor}/role`,{method:'PATCH',headers:{authorization:'Bearer admin-session','content-type':'application/json'},body:JSON.stringify({role:'member',reason:'Approved'})});
  assert.equal((await vipApi({request:selfRequest,env:{SUPABASE_SERVICE_ROLE_KEY:'test'}})).status,400);assert.equal(rpcCalls,0);
});

test('admin performance page stays gated and returns live member list without telemetry queries', async t => {
  const actor='00000000-0000-4000-8000-000000000010';let rpcCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:'00000000-0000-4000-8000-000000000011',email:'member@test.invalid',display_name:'Test Member'}]);if(value.includes('/rpc/helix_member_performance_summary'))rpcCalls++;return Response.json([])});
  const request=new Request('https://local.test/vip/api/admin/performance?page=1&week_start=2026-10-05&month=2026-10',{headers:{authorization:'Bearer admin-session'}});
  const response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'false',EA_R7_TELEMETRY_READY:'false',SUPABASE_SERVICE_ROLE_KEY:'test'}}),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.status,'WAITING_FOR_EA_R7');assert.equal(data.members[0].email,'member@test.invalid');assert.equal(rpcCalls,0);
});

test('admin performance groups each member by calling the existing date-filtered member summary RPC', async t => {
  const actor='00000000-0000-4000-8000-000000000010',member='00000000-0000-4000-8000-000000000011';const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:member,email:'member@test.invalid',display_name:'Test Member'}]);if(value.includes('/rest/v1/helix_general_settings?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/rpc/helix_member_performance_summary')){const args=JSON.parse(options.body);calls.push(args);if(args.p_from==='2026-09-01T00:00:00'&&!args.p_to)return Response.json({status:'READY',by_currency:[{currency:'USD',trades:10,wins:6,losses:4,break_even:0,gross_profit:600,gross_loss:100,net_pnl:500}]});if(args.p_from==='2026-09-01T00:00:00'&&args.p_to==='2026-10-01T00:00:00')return Response.json({status:'READY',by_currency:[{currency:'USD',trades:1,wins:1,losses:0,break_even:0,gross_profit:25,gross_loss:0,net_pnl:25}]});if(args.p_from==='2026-10-05T00:00:00')return Response.json({status:'READY',by_currency:[{currency:'USD',trades:1,wins:1,losses:0,break_even:0,gross_profit:20,gross_loss:0,net_pnl:20}]});if(args.p_from==='2026-09-28T00:00:00')return Response.json({status:'READY',by_currency:[{currency:'USD',trades:1,wins:1,losses:0,break_even:0,gross_profit:10,gross_loss:0,net_pnl:10}]});if(args.p_from==='2026-10-01T00:00:00')return Response.json({status:'READY',by_currency:[{currency:'USD',trades:1,wins:1,losses:0,break_even:0,gross_profit:50,gross_loss:0,net_pnl:50}]});throw new Error(`Unexpected range: ${args.p_from}`)}throw new Error(`Unexpected request: ${url}`)});
  const request=new Request('https://local.test/vip/api/admin/performance?page=1&week_start=2026-10-05&month=2026-10',{headers:{authorization:'Bearer admin-session'}});
  const response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'true',EA_R7_TELEMETRY_READY:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));const summary=data.summaries[0];assert.equal(calls.length,5);assert.ok(calls.every(x=>x.p_member_id===member));assert.equal(summary.lifetime.net_pnl_usd,500);assert.equal(summary.weekly.net_pnl_usd,20);assert.equal(summary.weekly.growth_pct,100);assert.equal(summary.monthly.net_pnl_usd,50);assert.equal(summary.monthly.growth_pct,100);
});

test('portal admin and member source use only branded dialogs for actions and contain no native popup calls', async () => {
  const paths=['public/vip/index.html','public/vip/admin/index.html','public/vip/helix-ui/js/portal-r1.js'];
  for(const path of paths){const source=await readFile(path,'utf8');assert.doesNotMatch(source,/(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(/,`${path} must not use browser popups`);}
  const admin=await readFile('public/vip/admin/index.html','utf8'),ui=await readFile('public/vip/helix-ui/js/helix-ui.js','utf8'),migration=await readFile('supabase/migrations/202610110002_helix_admin_member_roles.sql','utf8');
  assert.match(admin,/data-member-role/);assert.match(admin,/admin\/members\/\$\{b\.dataset\.memberRole\}\/role/);assert.match(ui,/hx-dialog-backdrop/);assert.match(migration,/ADMIN_REQUIRED/);assert.match(migration,/LAST_ADMIN/);assert.match(migration,/helix_member_role_audit/);
  for(const path of ['public/vip/index.html','public/vip/admin/index.html']){const html=await readFile(path,'utf8');for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){if(match[1].trim())new vm.Script(match[1],{filename:path});}}
  new vm.Script(ui,{filename:'helix-ui.js'});
});

test('admin performance is one account table with filters and 15-member pages', async () => {
  const admin=await readFile('public/vip/admin/index.html','utf8'),api=await readFile('functions/vip/api/[[path]].js','utf8'),css=await readFile('public/vip/helix-ui/css/portal-r1.css','utf8');
  assert.match(admin,/\['Performance','chart'\]/);assert.match(admin,/Recorded HELIX Performance per akun MT5/);assert.match(admin,/First Recorded Trade/);assert.match(admin,/Last Sync/);assert.match(admin,/Histori sebelum First Recorded Trade mungkin tidak lengkap/);assert.match(admin,/replace\('T',' '\)\.slice\(0,19\)/);assert.match(admin,/Net Profit \(USD\)/);assert.match(admin,/Closed Trades/);assert.match(admin,/Win \/ Loss/);assert.match(admin,/Magic Base/);assert.match(admin,/memberIds\.slice\(start,start\+15\)/);assert.match(admin,/accountPerformanceTable\(rows\.filter/);assert.match(admin,/account-perf-search/);assert.doesNotMatch(admin,/Trading Performance Member|data-account-performance-detail|Lihat detail|performance-week|performance-month|loadAdminPerformance/);assert.match(api,/admin\/performance/);assert.match(api,/helix_member_performance_summary/);assert.match(api,/first_recorded_trade_at/);assert.match(css,/admin-performance-table/);
  for(const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/admin.html','public/vip/login.html','public/vip/login/index.html'])assert.match(await readFile(path,'utf8'),/rel=\"icon\" type=\"image\/svg\+xml\" href=\"\/vip\/favicon\.svg\"/);
  await access('public/vip/favicon.svg');
});

test('admin account performance includes every binding of an authorized canary member, including real accounts', async t => {
  const actor='00000000-0000-4000-8000-000000000010',member='00000000-0000-4000-8000-000000000011',license='00000000-0000-4000-8000-000000000012',binding='00000000-0000-4000-8000-000000000013';
  const real='00000000-0000-4000-8000-000000000014';
  t.mock.method(globalThis,'fetch',async (url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_telemetry_canary_allowlist?'))return Response.json([{binding_id:binding}]);if(value.includes('/rest/v1/helix_license_bindings?'))return Response.json([{id:binding,license_id:license,broker_server:'Demo Broker',account_login:'12345678',mode:'demo',magic_base:681000,last_sync_at:'2026-10-12T06:44:39Z',released_at:null},{id:real,license_id:license,broker_server:'Real Broker',account_login:'87654321',mode:'real',magic_base:681000,last_sync_at:'2026-10-12T06:44:39Z',released_at:null}]);if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:member,product_slug:'quadriga',status:'active',expires_at:'2028-10-10T00:00:00Z',license_key_hint:'••1234'}]);if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:member,email:'member@test.invalid',display_name:'Test Member'}]);if(value.includes('/rest/v1/helix_license_sessions?'))return Response.json([{binding_id:binding,last_telemetry_sync_at:'2026-10-12T06:44:39Z'},{binding_id:real,last_telemetry_sync_at:'2026-10-12T06:44:39Z'}]);if(value.includes('/rest/v1/helix_completed_trades?'))return Response.json([]);if(value.includes('/rest/v1/helix_general_settings?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_member_performance_canary_summary_v2'))return Response.json({status:'READY',last_sync_at:'2026-10-12T06:44:39Z',by_currency:[{currency:'USD',trades:2,wins:1,losses:1,break_even:0,gross_profit:10,gross_loss:2,net_pnl:8}]});throw new Error(`Unexpected request: ${url}`)});
  const request=new Request(`https://local.test/vip/api/admin/performance/accounts?from=2026-09-01`,{headers:{authorization:'Bearer admin-session'}});
  const response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'false',EA_R7_TELEMETRY_READY:'false',PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.status,'CANARY');assert.equal(data.accounts.length,2);assert.deepEqual(data.accounts.map(row=>row.mode).sort(),['demo','real']);for(const account of data.accounts){assert.equal(account.magic_base,681000);assert.equal(account.metrics.total_closed_trades,2);assert.equal(account.metrics.wins,1);assert.equal(account.metrics.losses,1);assert.equal(account.metrics.net_pnl_usd,8);assert.equal(account.metrics.profit_factor,5)}
});

test('member canary automatically includes all owned demo and real bindings without another binding grant', async t => {
  const actor='00000000-0000-4000-8000-000000000010',license='00000000-0000-4000-8000-000000000012',demo='00000000-0000-4000-8000-000000000013',real='00000000-0000-4000-8000-000000000014';let rpcBindings=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:actor,email:'member@test.invalid',display_name:'Test Member',role:'member'}]);if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:actor,product_slug:'quadriga',status:'active',expires_at:'2028-10-10T00:00:00Z',license_key_hint:'••1234'}]);if(value.includes('/rest/v1/helix_license_bindings?'))return Response.json([{id:demo,license_id:license,broker_server:'Demo Broker',account_login:'12345678',mode:'demo',magic_base:681000},{id:real,license_id:license,broker_server:'Real Broker',account_login:'87654321',mode:'real',magic_base:681000}]);if(value.includes('/rest/v1/helix_license_sessions?'))return Response.json([{binding_id:demo,last_telemetry_sync_at:'2026-10-12T06:44:39Z'}]);if(value.includes('/rest/v1/helix_telemetry_canary_allowlist?'))return Response.json([{binding_id:demo}]);if(value.includes('/rest/v1/helix_completed_trades?'))return Response.json([{closed_at_broker:'2026-10-12T00:10:03'}]);if(value.includes('/rest/v1/helix_general_settings?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_member_performance_canary_summary_v2')){const args=JSON.parse(options.body);rpcBindings.push(args.p_binding_id);return Response.json({status:'READY',last_sync_at:'2026-10-12T06:44:39Z',by_currency:[{currency:'USD',trades:1,wins:1,losses:0,break_even:0,gross_profit:10,gross_loss:0,net_pnl:10}]})}throw new Error(`Unexpected request: ${url}`)});
  const request=new Request('https://local.test/vip/api/member/performance/accounts?from=2026-09-01',{headers:{authorization:'Bearer member-session'}});
  const response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'false',EA_R7_TELEMETRY_READY:'false',PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.accounts.length,2);assert.deepEqual(rpcBindings,[demo,real]);const demoRow=data.accounts.find(row=>row.mode==='demo'),realRow=data.accounts.find(row=>row.mode==='real');assert.equal(demoRow.metrics.net_pnl_usd,10);assert.equal(demoRow.metrics.total_closed_trades,1);assert.equal(demoRow.first_recorded_trade_at,'2026-10-12T00:10:03');assert.equal(realRow.capture_scope,'CANARY');assert.equal(realRow.metrics.net_pnl_usd,10);assert.equal(data.from,'2026-09-01T00:00:00');
});

test('member growth chart endpoint converts selected authorized accounts to USD and masks login', async t => {
  const actor='00000000-0000-4000-8000-000000000010',license='00000000-0000-4000-8000-000000000012',binding='00000000-0000-4000-8000-000000000013';let rpcCalls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'member@test.invalid',display_name:'Test Member',role:'member'}]);if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:actor,product_slug:'quadriga'}]);if(value.includes('/rest/v1/helix_license_bindings?'))return Response.json([{id:binding,license_id:license,broker_server:'Demo Broker',account_login:'12345678'}]);if(value.includes('/rest/v1/helix_telemetry_canary_allowlist?'))return Response.json([{binding_id:binding}]);if(value.includes('/rest/v1/helix_general_settings?'))return Response.json([{setting_key:'usc_per_usd',setting_value:100}]);if(value.includes('/rest/v1/rpc/helix_member_performance_canary_daily_v2')){rpcCalls++;return Response.json([{broker_date:'2026-10-20',currency:'USC',net_pnl:3000,trades:3}])}throw new Error(`Unexpected request: ${url}`)});
  const request=new Request(`https://local.test/vip/api/member/performance/growth?binding_ids=${binding}&from=2026-10-01&to=2026-10-22`,{headers:{authorization:'Bearer member-session'}}),response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'false',EA_R7_TELEMETRY_READY:'false',PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.series.length,1);assert.match(data.series[0].label,/Demo Broker.*5678/);assert.deepEqual(data.series[0].points,[{date:'2026-10-20',net_pnl_usd:30,trades:3}]);assert.equal(rpcCalls,1);assert.equal(JSON.stringify(data).includes('12345678'),false);
});

test('member growth converts IDR, USC, and configured USDC using General Settings rates',async t=>{
  const actor='00000000-0000-4000-8000-000000000010',license='00000000-0000-4000-8000-000000000012',binding='00000000-0000-4000-8000-000000000013';
  t.mock.method(globalThis,'fetch',async(url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'member@test.invalid',display_name:'Test Member',role:'member'}]);if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:actor,product_slug:'quadriga'}]);if(value.includes('/rest/v1/helix_license_bindings?'))return Response.json([{id:binding,license_id:license,broker_server:'Demo Broker',account_login:'12345678'}]);if(value.includes('/rest/v1/helix_telemetry_canary_allowlist?'))return Response.json([{binding_id:binding}]);if(value.includes('/rest/v1/helix_general_settings?'))return Response.json([{setting_key:'usd_idr_rate',setting_value:15000},{setting_key:'usc_per_usd',setting_value:100},{setting_key:'currency_usd_rates',setting_value:{USDC:1}}]);if(value.includes('/rest/v1/rpc/helix_member_performance_canary_daily_v2'))return Response.json([{broker_date:'2026-10-20',currency:'IDR',net_pnl:15000,trades:1},{broker_date:'2026-10-20',currency:'USC',net_pnl:3000,trades:3},{broker_date:'2026-10-20',currency:'USDC',net_pnl:2.5,trades:1}]);throw new Error(`Unexpected request: ${url}`)});
  const request=new Request(`https://local.test/vip/api/member/performance/growth?binding_ids=${binding}&from=2026-10-01&to=2026-10-22`,{headers:{authorization:'Bearer member-session'}}),response=await vipApi({request,env:{PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.deepEqual(data.series[0].points,[{date:'2026-10-20',net_pnl_usd:33.5,trades:5}]);assert.match(data.series[0].label,/Demo Broker · ••••5678/);
});

test('member growth chart refuses a binding not owned by the logged-in member', async t => {
  const actor='00000000-0000-4000-8000-000000000010',license='00000000-0000-4000-8000-000000000012',binding='00000000-0000-4000-8000-000000000013';let rpcCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'member@test.invalid',display_name:'Test Member',role:'member'}]);if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:actor,product_slug:'quadriga'}]);if(value.includes('/rest/v1/helix_license_bindings?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_member_performance'))rpcCalls++;throw new Error(`Unexpected request: ${url}`)});
  const request=new Request(`https://local.test/vip/api/member/performance/growth?binding_ids=${binding}&from=2026-10-01&to=2026-10-22`,{headers:{authorization:'Bearer member-session'}}),response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'true',EA_R7_TELEMETRY_READY:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();assert.equal(response.status,403);assert.equal(data.error,'INVALID_FILTER');assert.equal(rpcCalls,0);
});

test('member growth chart permits read-only performance history for owned released bindings',async t=>{
  const actor='00000000-0000-4000-8000-000000000010',license='00000000-0000-4000-8000-000000000012',binding='00000000-0000-4000-8000-000000000013';let rpcCalls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'member@test.invalid',display_name:'Test Member',role:'member'}]);if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:license,member_id:actor,product_slug:'quadriga'}]);if(value.includes('/rest/v1/helix_license_bindings?')){assert.doesNotMatch(value,/released_at=is\.null/);return Response.json([{id:binding,license_id:license,broker_server:'Demo Broker',account_login:'12345678',released_at:'2026-10-20T00:00:00Z'}])}if(value.includes('/rest/v1/helix_telemetry_canary_allowlist?'))return Response.json([{binding_id:binding}]);if(value.includes('/rest/v1/helix_general_settings?'))return Response.json([]);if(value.includes('/rest/v1/rpc/helix_member_performance_canary_daily_v2')){rpcCalls++;return Response.json([{broker_date:'2026-10-20',currency:'USD',net_pnl:12,trades:1}])}throw new Error(`Unexpected request: ${url}`)});
  const request=new Request(`https://local.test/vip/api/member/performance/growth?binding_ids=${binding}&from=2026-10-01&to=2026-10-22`,{headers:{authorization:'Bearer member-session'}}),response=await vipApi({request,env:{PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.series[0].points[0].net_pnl_usd,12);assert.equal(rpcCalls,1);
});

test('member growth UI appears above MT5 accounts with responsive daily, weekly, monthly and duration controls', async()=>{
  const ui=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8'),loader=await readFile('public/vip/helix-ui/js/portal-r1-loader.js','utf8'),css=await readFile('public/vip/helix-ui/css/portal-r1.css','utf8');assert.match(ui,/showMemberGrowthChart\(content,panel\);showMemberAccountPerformance\(content,panel\)/);assert.match(ui,/accountPanel\.before\(host\)/);assert.match(ui,/data-growth-unit="day"/);assert.match(ui,/data-growth-unit="week"/);assert.match(ui,/data-growth-unit="month"/);assert.match(ui,/Semua data tersedia \(sejak 1 Sep 2026\)/);assert.match(loader,/member-growth-chart-20261023-r4/);assert.match(css,/@media\(max-width:760px\)/);assert.match(css,/@media\(max-width:460px\)/);
});

test('member growth chart helpers exist and filters are collapsed until applied',async()=>{
  const ui=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8'),loader=await readFile('public/vip/helix-ui/js/portal-r1-loader.js','utf8'),shell=await readFile('public/vip/index.html','utf8'),css=await readFile('public/vip/helix-ui/css/portal-r1.css','utf8'),api=await readFile('functions/vip/api/[[path]].js','utf8');assert.match(ui,/function drawGrowth\(/);assert.match(ui,/hx-growth-hitpoints/);assert.match(ui,/hx-growth-tooltip/);assert.match(ui,/pointerenter/);assert.match(ui,/Total PnL: US\$\$\{formatNumber\(value\)\} USD/);assert.match(ui,/data-growth-controls hidden/);assert.match(ui,/data-growth-filter-toggle aria-expanded="false"/);assert.match(ui,/data-growth-apply/);assert.match(ui,/controls\.hidden=true;toggle\.setAttribute\('aria-expanded','false'\);[\s\S]*?load\(\)/);assert.match(loader,/portal-r1\.js\?v=member-growth-chart-20261023-r4/);assert.match(shell,/portal-r1-loader\.js\?v=member-growth-chart-20261023-r4/);assert.match(css,/\.hx-growth-axis\{[^}]*stroke:none!important/);assert.match(css,/\.hx-growth-tooltip\{[^}]*backdrop-filter:blur/);assert.doesNotMatch(api,/Â· â€¢/);
});

test('telemetry ingestion skips history earlier than the HELIX launch floor without blocking the batch', async t => {
  let writes=0;t.mock.method(globalThis,'fetch',async url=>{if(String(url).includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(String(url).includes('/rest/v1/rpc/helix_ingest_telemetry_deals_v2'))writes++;throw new Error(`Unexpected request: ${url}`)});
  const deal={deal_ticket:'1',position_id:'1',occurred_at_broker:'2026-08-31T23:59:59',direction:'BUY',entry_kind:'IN',volume:0.1,profit:0,commission:0,swap:0,fee:0,currency:'USD',symbol:'EURUSD',magic:681001};
  const request=new Request('https://local.test/api/telemetry/v1/deals',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'a'.repeat(48)},body:JSON.stringify({schema_version:'2-broker-time',time_basis:'BROKER_SERVER',magic_base:681000,deals:[deal]})});
  const response=await telemetry({request,env:{PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();assert.equal(response.status,200);assert.equal(data.accepted,0);assert.equal(data.ignored_outside_window,1);assert.equal(data.minimum_broker_date,'2026-09-01');assert.equal(writes,0);
});

test('canary transaction details reject a real binding even when an admin requests its UUID', async t => {
  const actor='00000000-0000-4000-8000-000000000010',binding='00000000-0000-4000-8000-000000000013';
  t.mock.method(globalThis,'fetch',async url=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/helix_license_bindings?'))return Response.json([{id:binding,license_id:'00000000-0000-4000-8000-000000000012',mode:'real',released_at:null}]);if(value.includes('/rest/v1/helix_licenses?'))return Response.json([{id:'00000000-0000-4000-8000-000000000012',member_id:'00000000-0000-4000-8000-000000000015',status:'active'}]);if(value.includes('/rest/v1/helix_telemetry_canary_allowlist?'))return Response.json([]);throw new Error(`Unexpected request: ${url}`)});
  const request=new Request(`https://local.test/vip/api/admin/performance/details?binding_id=${binding}`,{headers:{authorization:'Bearer admin-session'}});
  const response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'false',EA_R7_TELEMETRY_READY:'false',PORTAL_PERFORMANCE_CANARY_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,403);assert.equal(data.error,'PERFORMANCE_CANARY_ONLY');
});

test('telemetry canary SQL authorizes by member grant and keeps session, license, binding, and magic checks', async () => {
  const sql=await readFile('supabase/migrations/202610120002_helix_telemetry_canary_member_auto.sql','utf8');
  assert.match(sql,/helix_is_telemetry_canary_member\(l\.member_id\)/);
  assert.doesNotMatch(sql,/b\.mode\s*<>\s*'demo'/);
  assert.match(sql,/s\.expires_at<=now\(\)/);
  assert.match(sql,/l\.status<>'active'/);
  assert.match(sql,/b\.released_at is not null/);
  assert.match(sql,/p_magic_base\+47/);
  assert.match(sql,/on conflict\(binding_id,deal_ticket\)/);
  const admin=await readFile('public/vip/admin/index.html','utf8');
  assert.match(admin,/Akun MT5 Terhubung/);assert.match(admin,/d\.bindings\.filter\(binding=>!binding\.released_at\)\.length/);
  assert.doesNotMatch(admin,/function productAndHealth\(/);assert.doesNotMatch(admin,/Aktivasi Aktif/);
});

test('VIP/Admin source contains no mojibake control bytes or common UTF-8 decoding artifacts', async () => {
  for(const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/admin.html','public/vip/login.html','public/vip/login/index.html','public/vip/helix-ui/js/portal-r1.js','public/vip/helix-ui/js/helix-ui.js']){
    const source=await readFile(path,'utf8');assert.doesNotMatch(source,/[\u0080-\u009f]/,`${path} contains an invalid C1 control character`);assert.doesNotMatch(source,/(?:\u00c3[\u0080-\u00ff]|\u00c2[\u0080-\u00ff]|\u00e2(?:\u20ac|\u2013|\u2020)|\u00ef\u00bc)/,`${path} contains mojibake`);
  }
});

test('pair poll and telemetry reject missing session proof before database access', async t => {
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not call db')});
  const request = new Request('https://local.test/api', {method:'POST',headers:{'content-type':'application/json',origin:'https://www.robodigimart.com'},body:'{}'});
  assert.equal((await pairPoll({request,env:{}})).status,401);
  assert.equal((await telemetry({request,env:{}})).status,401);
  assert.equal(calls,0);
});

test('all portal inline scripts parse and the 7 member menus plus 7 admin menus remain', async () => {
  for (const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/login.html','public/vip/login/index.html']) {
    const html=await readFile(path,'utf8');let count=0;
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1],{filename:path+':inline'+(++count)});
  }
  const member=await readFile('public/vip/index.html','utf8'),memberR1=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8'),admin=await readFile('public/vip/admin/index.html','utf8');
  assert.equal((member.match(/\['(?:dashboard|licenses|accounts|activity|announcements|materials|profile)'/g)||[]).length,7);
  assert.equal((admin.match(/\['(?:Dashboard|Member|Performance|License & Akun|Announcement|Material|Permintaan Email)'/g)||[]).length,7);
  assert.match(admin,/\['Permintaan Email','mail'\].*\['General Settings','settings'\]/);
  assert.match(admin,/data-email-pending-badge/);assert.match(admin,/memberPage\*50/);assert.match(admin,/\b50 per halaman\b/);
  const adminUi=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8');
  assert.match(adminUi,/window\.helixPendingEmailCount=requests\.length/);
  assert.match(adminUi,/emailQueueIntro&&emailQueueIntro\.textContent!==emailQueueCopy/,'email-queue copy avoids repeatedly mutating and stalling MutationObserver');
  assert.match(admin,/Performance per akun MT5/);assert.doesNotMatch(admin,/data-account-performance-detail|Lihat detail|Trading Performance Member/);assert.match(admin,/License & Akun/);assert.match(admin,/function performancePage\(\)[\s\S]*?accountPerformancePanel\(\)/);
  assert.match(memberR1,/Performance per akun MT5/);assert.match(memberR1,/member\/performance\/accounts/);
});

test('R1 UI scripts parse and shipped assets exist', async () => {
  for (const path of ['public/vip/helix-ui/js/portal-r1.js','public/vip/helix-ui/js/portal-r1-loader.js']) new vm.Script(await readFile(path,'utf8'),{filename:path});
  for (const path of ['public/vip/helix-ui/css/tokens.css','public/vip/helix-ui/css/components.css','public/vip/helix-ui/css/portal-adapter.css','public/vip/helix-ui/css/portal-r1.css','public/vip/helix-ui/backgrounds/mountain-hero.webp','public/vip/helix-ui/backgrounds/mountain-sidebar.webp','public/vip/helix-ui/icons/home.svg','public/vip/helix-ui/icons/key.svg']) await access(path);
});

test('member, admin, and login shells use the supplied HELIX brand and SVG assets', async () => {
  for (const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/login.html','public/vip/login/index.html']) {
    const html=await readFile(path,'utf8');
    assert.match(html,/\/vip\/helix-ui\/brand\/helix-emblem\.webp/);
    assert.doesNotMatch(html,/src="\/images\/helix-emblem\.webp"/);
  }
  const css=await readFile('public/vip/helix-ui/css/portal-r1.css','utf8');
  assert.match(css,/\.login-logo>img/);
  assert.match(css,/\.role-pill img/);
});

test('invite and recovery password success requires an in-app confirmation then returns to a clean login URL', async () => {
  for (const path of ['public/vip/login.html','public/vip/login/index.html']) {
    const html=await readFile(path,'utf8');
    assert.match(html,/function showPasswordSaved\(\)/);
    assert.match(html,/Password berhasil disimpan[\s\S]*Tekan OK untuk kembali ke halaman login/);
    assert.match(html,/await client\.auth\.signOut\(\);await showPasswordSaved\(\);sessionStorage\.setItem\('helix-password-updated','1'\);location\.replace\('\/vip\/login'\)/);
    assert.match(html,/sessionStorage\.removeItem\('helix-password-updated'\)/);
    const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).at(-1);
    new vm.Script(inline,{filename:path});
  }
});

test('member profile uses one performance card above the profile and labels logout clearly', async () => {
  const portal=await readFile('public/vip/index.html','utf8');
  const enhancements=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8');
  assert.match(portal,/data-logout[^>]*>KELUAR<\/button>/);
  assert.doesNotMatch(portal,/Keluar dari HELIX/);
  assert.match(portal,/class="profile-identity"[\s\S]*class="profile-identity-copy"/);
  assert.match(enhancements,/await featureStatusReady;[\s\S]*if\(section\.querySelector\('\[data-r1-performance\]'\)\)return/);
  assert.match(enhancements,/if\(profile\)profile\.before\(host\);else section\.append\(host\)/);
  assert.match(enhancements,/Recorded HELIX Performance per akun MT5/);assert.match(enhancements,/First Recorded Trade/);assert.match(enhancements,/Last Sync/);assert.match(enhancements,/function formatBrokerTime\(value\)\{return value\?String\(value\)\.replace\('T',' '\)/);assert.doesNotMatch(enhancements,/new Date\(`\$\{a\.first_recorded_trade_at\}Z`\)/);
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

test('admin license deletion is admin-only, audited, revokes sessions, and keeps history', async t => {
  const actor='00000000-0000-4000-8000-000000000021',license='00000000-0000-4000-8000-000000000022';
  let rpcArgs;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const value=String(url);
    if(value.includes('/auth/v1/user'))return Response.json({id:actor});
    if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:actor,email:'admin@test.invalid',display_name:'Admin',role:'admin'}]);
    if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);
    if(value.includes('/rest/v1/rpc/helix_admin_delete_license')){rpcArgs=JSON.parse(options.body);return Response.json({ok:true,license_id:license,sessions_revoked:2,bindings_released:1});}
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request(`https://local.test/vip/api/admin/licenses/${license}`,{method:'PATCH',headers:{authorization:'Bearer admin-session','content-type':'application/json'},body:JSON.stringify({action:'delete',reason:'Customer requested cancellation'})});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key',PORTAL_LICENSE_MANAGEMENT_ENABLED:'true'}});
  assert.equal(response.status,200);assert.equal(rpcArgs.p_license_id,license);assert.equal(rpcArgs.p_actor_id,actor);assert.equal(rpcArgs.p_reason,'Customer requested cancellation');
  const migration=await readFile('supabase/migrations/202610120001_helix_admin_license_delete.sql','utf8');
  assert.match(migration,/deleted_at/);assert.match(migration,/status = 'revoked'/);assert.match(migration,/revoke_reason = coalesce\(revoke_reason, 'license_deleted'\)/);assert.match(migration,/license_deleted/);assert.match(migration,/bindings_released/);assert.match(migration,/event_type, metadata/);assert.match(migration,/ADMIN_REQUIRED/);assert.match(migration,/revoke all on function public\.helix_admin_delete_license[\s\S]*grant execute on function public\.helix_admin_delete_license[\s\S]*service_role/);
});

test('member cannot delete a license and deleted licenses are hidden from their portal', async t => {
  const actor='00000000-0000-4000-8000-000000000023',license='00000000-0000-4000-8000-000000000024';let rpcCalls=0;
  t.mock.method(globalThis,'fetch',async (url)=>{
    const value=String(url);
    if(value.includes('/auth/v1/user'))return Response.json({id:actor});
    if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:actor,email:'member@test.invalid',display_name:'Member',role:'member'}]);
    if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);
    if(value.includes('/rpc/helix_admin_delete_license'))rpcCalls++;
    throw new Error(`Unexpected request: ${url}`);
  });
  const request=new Request(`https://local.test/vip/api/admin/licenses/${license}`,{method:'PATCH',headers:{authorization:'Bearer member-session','content-type':'application/json'},body:JSON.stringify({action:'delete',reason:'Member should not do this'})});
  const response=await vipApi({request,env:{SUPABASE_SERVICE_ROLE_KEY:'local-test-key',PORTAL_LICENSE_MANAGEMENT_ENABLED:'true'}});
  assert.equal(response.status,403);assert.equal(rpcCalls,0);
  const api=await readFile('functions/vip/api/[[path]].js','utf8');
  assert.match(api,/listLicenses\(env, `member_id=eq\.\$\{id\}&deleted_at=is\.null`\)/);
});

test('member and admin portals share a 30-minute cross-tab idle sign-out', async () => {
  const idle=await readFile('public/vip/helix-ui/js/idle-timeout.js','utf8');
  const loader=await readFile('public/vip/helix-ui/js/portal-r1-loader.js','utf8');
  assert.match(idle,/30 \* 60 \* 1000/);assert.match(idle,/pointerdown.*keydown.*touchstart.*wheel.*mousemove/);assert.match(idle,/scope: 'local'/);assert.match(idle,/helix:portal:idle-logout/);assert.match(idle,/removeItem\(activityKey\)/);
  assert.match(loader,/idle-timeout\.js\?v=idle-30m-20261012b/);
  new vm.Script(idle,{filename:'idle-timeout.js'});new vm.Script(loader,{filename:'portal-r1-loader.js'});
});

test('admin license panel offers confirmed audited deletion and MT5 slot release actions', async () => {
  const admin=await readFile('public/vip/admin/index.html','utf8');
  assert.match(admin,/data-license-delete=/);assert.match(admin,/Alasan penghapusan \(wajib\)/);assert.match(admin,/Konfirmasi penghapusan license/);assert.match(admin,/action:'delete',reason/);
  assert.match(admin,/data-release="\$\{l\?\.id\}"/);assert.match(admin,/v18k\?'Force Release':'Lepas slot'/);assert.match(admin,/Alasan untuk audit/);
  const adapter=await readFile('public/vip/helix-ui/js/portal-r1.js','utf8');assert.match(adapter,/Force Release langsung membebaskan slot/);assert.match(adapter,/force_release_acknowledged:Boolean\(v18k\)/);
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
  const mainRequest=new Request('https://www.robodigimart.com/');let forwarded=mainRequest;
  const mainResponse=await vipHostRouting({request:mainRequest,next:async value=>{forwarded=value||mainRequest;return new Response('ok');}});
  assert.equal(mainResponse.status,302);
  assert.equal(mainResponse.headers.get('location'),'https://www.robodigimart.com/id');
  const nonRoot=new Request('https://www.robodigimart.com/id');
  await vipHostRouting({request:nonRoot,next:async value=>{forwarded=value||nonRoot;return new Response('ok');}});
  assert.equal(forwarded.url,nonRoot.url,'marketing host non-root routes are unchanged');
});

