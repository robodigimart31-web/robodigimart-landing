import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import worker from './worker.mjs';

const migration=await readFile(new URL('./migrations/0002_telemetry_deal_ledger.sql',import.meta.url),'utf8');
const makeDeal=(id,position,type,profit,time,entry,extra={})=>({id:String(id),position:String(position),type,profit,commission:0,swap:0,fee:0,time,entry,magic:681001,volume:.01,...extra});
const stamp=ms=>new Date(ms).toISOString().slice(0,19).replaceAll('-','.').replace('T',' ');
function setup({baseline=true,failBatch=false}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE live_state(id INTEGER PRIMARY KEY CHECK(id=1),account_hash TEXT NOT NULL,recorded_at TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE snapshots(recorded_at TEXT PRIMARY KEY,balance REAL NOT NULL,equity REAL NOT NULL,cashflow REAL NOT NULL);`);
 const legacy={scope:'helix_magic_681',schema_version:3,chart_basis:'profit',report:{series_slug:'quadriga',kind:'live',label:'HELIX QUADRIGA',account_type:'real',currency:'USC',symbol:'XAUUSDc',net_profit:321,total_trades:17,updated_at:'2026-10-18T08:00:00.000Z'},monthly:[],points:[{recorded_at:'2026-10-04T00:00:00Z',profit:0},{recorded_at:'2026-10-18T08:00:00Z',profit:321}]};
 if(baseline){const accountHash=createHash('sha256').update(salt+'\0'+'TEST-SERVER'+'\0'+'123456').digest('hex');sqlite.prepare('INSERT INTO live_state VALUES(1,?,?,?)').run(accountHash,'2026-10-18T08:00:00.000Z',JSON.stringify(legacy));}
 sqlite.exec(migration);
 const db={prepare(sql){let args=[];return {sql,get args(){return args;},bind(...values){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return sqlite.prepare(sql).run(...args);}};},async batch(stmts){if(failBatch)throw Error('injected batch failure');sqlite.exec('BEGIN IMMEDIATE');try{const out=stmts.map(s=>sqlite.prepare(s.sql).run(...s.args));sqlite.exec('COMMIT');return out.map(x=>({meta:{changes:x.changes}}));}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {sqlite,db,legacy,get deals(){return sqlite.prepare('select count(*) n from telemetry_deals').get().n;},get live(){return sqlite.prepare('select payload from live_state where id=1').get()?.payload;}};
}
const secret='p'.repeat(48),salt='s'.repeat(48);
function payload(timestamp,deals,account='123456',broker='TEST-SERVER') {return {version:3,scope:'helix_magic_681',history_from:'2026.10.04 00:00:00',broker_now:stamp(timestamp),recorded_at_unix:Math.floor(timestamp/1000),account_type:'real',account_login:account,broker,currency:'USC',symbol:'XAUUSDc',deals};}
async function publish(db,p,auth=secret){return worker.fetch(new Request('https://helix-performance.test/api/publisher/mt5',{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify(p)}),{DB:db,PUBLISHER_API_KEY:secret,ACCOUNT_HASH_SALT:salt});}
async function publicRead(db){return worker.fetch(new Request('https://helix-performance.test/api/performance'),{DB:db});}
const pair=(n,day='05')=>[makeDeal(n*2,n,0,0,`2026.10.${day} 10:00:00`,0),makeDeal(n*2+1,n,1,10,`2026.10.${day} 10:01:00`,1)];

test('legacy public baseline remains byte-for-byte while ledger candidate receives 100 + 20 and archived windows never delete',async()=>{
 const x=setup(),t=Date.now(),initial=Array.from({length:50},(_,i)=>pair(i+1)).flat(),delta=Array.from({length:10},(_,i)=>pair(i+51,'10')).flat();
 for(const [offset,deals] of [[0,initial],[6*60000,delta],[12*60000,delta.slice(-2)]]){const r=await publish(x.db,payload(t+offset,deals));assert.equal(r.status,200,await r.text());}
 assert.equal(x.deals,120);
 const pub=await (await publicRead(x.db)).json();assert.equal(pub.live_status,'legacy_baseline_preserved');assert.deepEqual(pub.live,x.legacy);assert.equal(pub.live.report.net_profit,321);
 assert.equal(x.sqlite.prepare('select count(*) n from telemetry_deal_revisions').get().n,0);
 x.sqlite.close();
});
test('current ledger candidate calculates 120 unique deals after a broker archive window shrinks',async()=>{
 const x=setup(),t=Date.now(),first=Array.from({length:50},(_,i)=>pair(i+1)).flat(),more=Array.from({length:10},(_,i)=>pair(i+51,'10')).flat();
 assert.equal((await publish(x.db,payload(t,first))).status,200);assert.equal((await publish(x.db,payload(t+6*60000,more))).status,200);assert.equal((await publish(x.db,payload(t+12*60000,more.slice(-2)))).status,200);
 const c=JSON.parse(x.sqlite.prepare('select payload from telemetry_candidate').get().payload);assert.equal(c.report.net_profit,600);assert.equal(c.report.total_trades,60);assert.equal(c.points.at(-1).profit,600);x.sqlite.close();
});
test('correction to an existing strategy ticket is audited and current P/L changes once',async()=>{
 const x=setup({baseline:false}),t=Date.now(),deals=pair(1),changed={...deals[1],profit:15};
 assert.equal((await publish(x.db,payload(t,deals))).status,200);
 assert.equal((await publish(x.db,payload(t+6*60000,[{...changed,time:'2026.10.05 10:01:00'}]))).status,200);
 assert.equal(x.sqlite.prepare('select count(*) n from telemetry_deal_revisions').get().n,1);
 assert.equal(JSON.parse(x.sqlite.prepare('select payload from telemetry_candidate').get().payload).report.net_profit,15);x.sqlite.close();
});
test('broker correction/archive rows never add P/L or erase prior ticket history',async()=>{
 const x=setup({baseline:false}),t=Date.now();assert.equal((await publish(x.db,payload(t,pair(1)))).status,200);
 const excluded=makeDeal(777,77,2,999999,'2026.10.05 10:02:00',0,{magic:0});
 assert.equal((await publish(x.db,payload(t+6*60000,[excluded]))).status,200);
 assert.equal(x.deals,2);assert.equal(x.sqlite.prepare('select count(*) n from telemetry_deal_revisions').get().n,0);
 assert.equal(JSON.parse(x.sqlite.prepare('select payload from telemetry_candidate').get().payload).report.net_profit,10);x.sqlite.close();
});
test('failed atomic D1 batch leaves ledger, candidate and public baseline unchanged',async()=>{
 const x=setup({failBatch:true}),t=Date.now(),r=await publish(x.db,payload(t,pair(1)));assert.equal(r.status,503);assert.equal(x.deals,0);assert.equal(x.sqlite.prepare('select count(*) n from telemetry_candidate').get().n,0);assert.deepEqual((await (await publicRead(x.db)).json()).live,x.legacy);x.sqlite.close();
});
test('legacy Worker rollback writes are ignored while baseline mode is active',async()=>{
 const x=setup(),before=x.sqlite.prepare('select account_hash,recorded_at,payload from live_state where id=1').get();
 x.sqlite.prepare('update live_state set recorded_at=?,payload=? where id=1').run('2026-10-18T14:00:00.000Z','{"report":{"net_profit":999999}}');
 assert.deepEqual(x.sqlite.prepare('select account_hash,recorded_at,payload from live_state where id=1').get(),before);x.sqlite.close();
});
test('approved candidate is the only write allowed to replace live state and activates atomically',async()=>{
 const x=setup(),t=Date.now();x.sqlite.prepare("update telemetry_control set mode='ledger_approved_waiting_publish',coverage_attested_at='2026-10-18T13:00:00.000Z',coverage_attestation='isolated-test-only'").run();
 const r=await publish(x.db,payload(t,pair(1)));assert.equal(r.status,200,await r.text());
 const c=x.sqlite.prepare('select mode,published_revision from telemetry_control').get();assert.equal(c.mode,'ledger_verified');assert.equal(c.published_revision,1);
 const pub=await (await publicRead(x.db)).json();assert.equal(pub.live_status,'ledger_verified');assert.equal(pub.live.report.net_profit,10);assert.equal(pub.live.report.total_trades,1);x.sqlite.close();
});
test('unauthorized publisher makes no writes',async()=>{const x=setup(),r=await publish(x.db,payload(Date.now(),pair(1)),'wrong');assert.equal(r.status,401);assert.equal(x.deals,0);x.sqlite.close();});
test('different-account concurrent first publishers cannot cross-write ledger',async()=>{
 const x=setup({baseline:false}),t=Date.now();
 const results=await Promise.all([publish(x.db,payload(t,pair(1),'111111','BROKER-A')),publish(x.db,payload(t,pair(2),'222222','BROKER-B'))]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(x.deals,2);const owner=x.sqlite.prepare('select account_hash from telemetry_control').get().account_hash;
 const ledgerOwner=x.sqlite.prepare('select distinct account_hash from telemetry_deals').all();assert.equal(ledgerOwner.length,1);assert.equal(ledgerOwner[0].account_hash,owner);x.sqlite.close();
});
test('same-account simultaneous requests serialize; rejected stale/repeated timestamps do not alter ledger',async()=>{
 const x=setup({baseline:false}),t=Date.now(),results=await Promise.all([publish(x.db,payload(t,pair(1))),publish(x.db,payload(t,pair(2)))]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(x.deals,2);const stale=await publish(x.db,payload(t-60000,pair(3)));assert.equal(stale.status,409);assert.equal(x.deals,2);x.sqlite.close();
});
test('public response shape remains compatible and never exposes account login',async()=>{
 const x=setup(),r=await publicRead(x.db),v=await r.json();assert.equal(r.status,200);for(const k of ['configured','live','backtest'])assert.ok(k in v);assert.equal(v.live_status,'legacy_baseline_preserved');assert.ok(!JSON.stringify(v).includes('123456'));x.sqlite.close();
});
test('stale baseline remains served with original update timestamp for existing 15-hour stale indicator',async()=>{
 const x=setup(),baseline=JSON.parse(x.sqlite.prepare('select payload from telemetry_legacy_baseline').get().payload);baseline.report.updated_at='2026-10-17T00:00:00.000Z';
 x.sqlite.prepare('update telemetry_legacy_baseline set payload=?').run(JSON.stringify(baseline));
 const pub=await (await publicRead(x.db)).json();assert.equal(pub.live.report.updated_at,'2026-10-17T00:00:00.000Z');assert.ok(Date.now()-Date.parse(pub.live.report.updated_at)>15*3600*1000);x.sqlite.close();
});

