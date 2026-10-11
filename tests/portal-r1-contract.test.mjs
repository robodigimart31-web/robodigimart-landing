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
  t.mock.method(globalThis,'fetch',async (url,options)=>{const value=String(url);if(value.includes('/auth/v1/user'))return Response.json({id:actor});if(value.includes('/rest/v1/helix_member_suspensions?'))return Response.json([]);if(value.includes('/rest/v1/helix_members?')&&value.includes('id=eq.'))return Response.json([{id:actor,email:'admin@test.invalid',role:'admin'}]);if(value.includes('/rest/v1/helix_members?'))return Response.json([{id:member,email:'member@test.invalid',display_name:'Test Member'}]);if(value.includes('/rest/v1/rpc/helix_rate_limit'))return Response.json({allowed:true});if(value.includes('/rest/v1/rpc/helix_member_performance_summary')){const args=JSON.parse(options.body);calls.push(args);if(!args.p_from)return Response.json({status:'READY',total_closed_trades:10,net_pnl:500,winrate:60,profit_factor:1.5,currency:'USD'});if(args.p_from==='2026-10-04T17:00:00.000Z')return Response.json({status:'READY',net_pnl:20,currency:'USD'});if(args.p_from==='2026-09-27T17:00:00.000Z')return Response.json({status:'READY',net_pnl:10,currency:'USD'});if(args.p_from==='2026-09-30T17:00:00.000Z')return Response.json({status:'READY',net_pnl:50,currency:'USD'});if(args.p_from==='2026-08-31T17:00:00.000Z')return Response.json({status:'READY',net_pnl:25,currency:'USD'});throw new Error(`Unexpected range: ${args.p_from}`)}throw new Error(`Unexpected request: ${url}`)});
  const request=new Request('https://local.test/vip/api/admin/performance?page=1&week_start=2026-10-05&month=2026-10',{headers:{authorization:'Bearer admin-session'}});
  const response=await vipApi({request,env:{PORTAL_PERFORMANCE_ENABLED:'true',EA_R7_TELEMETRY_READY:'true',SUPABASE_SERVICE_ROLE_KEY:'test',PAIRING_HASH_SECRET:secret}}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));const summary=data.summaries[0];assert.equal(calls.length,5);assert.ok(calls.every(x=>x.p_member_id===member));assert.equal(summary.lifetime.net_pnl,500);assert.equal(summary.weekly.net_pnl,20);assert.equal(summary.weekly.growth_pct,100);assert.equal(summary.monthly.net_pnl,50);assert.equal(summary.monthly.growth_pct,100);
});

test('portal admin and member source use only branded dialogs for actions and contain no native popup calls', async () => {
  const paths=['public/vip/index.html','public/vip/admin/index.html','public/vip/helix-ui/js/portal-r1.js'];
  for(const path of paths){const source=await readFile(path,'utf8');assert.doesNotMatch(source,/(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(/,`${path} must not use browser popups`);}
  const admin=await readFile('public/vip/admin/index.html','utf8'),ui=await readFile('public/vip/helix-ui/js/helix-ui.js','utf8'),migration=await readFile('supabase/migrations/202610110002_helix_admin_member_roles.sql','utf8');
  assert.match(admin,/data-member-role/);assert.match(admin,/admin\/members\/\$\{b\.dataset\.memberRole\}\/role/);assert.match(ui,/hx-dialog-backdrop/);assert.match(migration,/ADMIN_REQUIRED/);assert.match(migration,/LAST_ADMIN/);assert.match(migration,/helix_member_role_audit/);
  for(const path of ['public/vip/index.html','public/vip/admin/index.html']){const html=await readFile(path,'utf8');for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){if(match[1].trim())new vm.Script(match[1],{filename:path});}}
  new vm.Script(ui,{filename:'helix-ui.js'});
});

test('admin has a dedicated paginated performance menu, existing RPC, weekly/monthly filters, and favicons', async () => {
  const admin=await readFile('public/vip/admin/index.html','utf8'),api=await readFile('functions/vip/api/[[path]].js','utf8');
  assert.match(admin,/\['Performance','chart'\]/);assert.match(admin,/Total profit/);assert.match(admin,/Win rate/);assert.match(admin,/Profit factor/);assert.match(admin,/performance-week/);assert.match(admin,/performance-month/);assert.match(api,/admin\/performance/);assert.match(api,/helix_member_performance_summary/);assert.doesNotMatch(api,/helix_admin_member_performance_summary/);
  for(const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/admin.html','public/vip/login.html','public/vip/login/index.html'])assert.match(await readFile(path,'utf8'),/rel="icon" type="image\/svg\+xml" href="\/vip\/favicon\.svg"/);
  await access('public/vip/favicon.svg');
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

test('all portal inline scripts parse and the existing 7 member menus plus 6 admin menus remain', async () => {
  for (const path of ['public/vip/index.html','public/vip/admin/index.html','public/vip/login.html','public/vip/login/index.html']) {
    const html=await readFile(path,'utf8');let count=0;
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1],{filename:path+':inline'+(++count)});
  }
  const member=await readFile('public/vip/index.html','utf8'),admin=await readFile('public/vip/admin/index.html','utf8');
  assert.equal((member.match(/\['(?:dashboard|licenses|accounts|activity|announcements|materials|profile)'/g)||[]).length,7);
  assert.equal((admin.match(/\['(?:Dashboard|Member|Performance|License|Announcement|Material)'/g)||[]).length,6);
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
  const mainRequest=new Request('https://www.robodigimart.com/');let forwarded=mainRequest;
  const mainResponse=await vipHostRouting({request:mainRequest,next:async value=>{forwarded=value||mainRequest;return new Response('ok');}});
  assert.equal(mainResponse.status,302);
  assert.equal(mainResponse.headers.get('location'),'https://www.robodigimart.com/id');
  const nonRoot=new Request('https://www.robodigimart.com/id');
  await vipHostRouting({request:nonRoot,next:async value=>{forwarded=value||nonRoot;return new Response('ok');}});
  assert.equal(forwarded.url,nonRoot.url,'marketing host non-root routes are unchanged');
});
