import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate,mergeDealLedger,validateIncoming} from './metrics.mjs';
const now=Date.parse('2026-10-10T08:00:00Z');
const deal=(id,type,profit,extra={})=>({id:String(id),time:'2026.10.05 10:00:00',type,entry:0,magic:681001,position:'10',volume:.01,profit,commission:0,swap:0,fee:0,...extra});
const payload=()=>({version:3,scope:'helix_magic_681',history_from:'2026.10.04 00:00:00',broker_now:'2026.10.10 10:00:00',recorded_at_unix:now/1000,account_type:'real',account_login:'123456',broker:'TEST-SERVER',currency:'USC',symbol:'XAUUSDc',deals:[deal(1,0,0,{commission:-2}),deal(2,1,10,{entry:1,commission:-2})]});
test('profit starts at zero; fees included; no account balance, equity, capital or DD',()=>{
 const r=calculate(payload(),now);assert.equal(r.report.net_profit,6);assert.equal(r.report.initial_balance,null);assert.equal(r.report.max_drawdown_pct,null);assert.equal(r.report.total_trades,1);assert.equal(r.report.win_rate,100);assert.equal(r.monthly[0].change,6);assert.equal(r.points[0].profit,0);assert.equal(r.points.at(-1).profit,6);assert.ok(r.points.every(p=>p.balance===null && p.equity===null));assert.equal(r.report.currency,'USC');
});
test('deposits, withdrawals, broker credits and unrelated manual/EA trades cannot affect ANY metric or chart',()=>{
 const p=payload();const expected=calculate(p,now);
 p.deals.push(deal(3,2,10000,{magic:0}),deal(4,2,-3000,{magic:0}),deal(5,3,500,{magic:0}));
 for(const magic of [0,680999,682000,6810000,999])p.deals.push(deal(100+magic,0,0,{magic,position:String(100+magic)}),deal(200+magic,1,5000,{magic,position:String(100+magic),entry:1}));
 assert.deepEqual(calculate(p,now),expected);
});
test('magic lower and upper bounds are included',()=>{
 for(const magic of [681000,681001,681021,681999]){const p=payload();p.deals.forEach(d=>d.magic=magic);assert.equal(calculate(p,now).report.net_profit,6);}
});
test('manual exit of a HELIX position is included; independently opened manual positions are not',()=>{
 const p=payload();p.deals[1].magic=0;assert.equal(calculate(p,now).report.net_profit,6);assert.equal(calculate(p,now).report.total_trades,1);
});
test('partial close contributes realized profit, not a completed position',()=>{
 const p=payload();p.deals[1].volume=.005;assert.equal(calculate(p,now).report.total_trades,0);assert.equal(calculate(p,now).report.net_profit,6);
});
test('entry fees change losing position classification and profit factor',()=>{
 const p=payload();p.deals.push(deal(5,0,0,{position:'20',commission:-2}),deal(6,1,1,{position:'20',entry:1,commission:-2}));const r=calculate(p,now);assert.equal(r.report.win_rate,50);assert.equal(r.report.profit_factor,2);assert.equal(r.report.net_profit,3);
});
test('reject ambiguous mixed netting, missing entry, missing magic, duplicate, V2, demo, date and clock errors',()=>{
 for(const modify of [p=>p.deals.push(deal(3,0,0,{magic:0})),p=>p.deals.splice(0,1),p=>delete p.deals[0].magic,p=>p.deals.push(p.deals[0]),p=>p.version=2,p=>p.account_type='demo',p=>p.history_from='2026.01.01 00:00:00',p=>p.recorded_at_unix-=3600]){const p=payload();modify(p);assert.throws(()=>calculate(p,now));}
});
test('public payload contains no identifiers or raw history; no HELIX trades is an honest zero',()=>{
 const p=payload();p.deals=[];const r=calculate(p,now);assert.equal(r.report.net_profit,0);assert.equal(r.report.win_rate,null);assert.equal(r.account_login,undefined);assert.equal(r.deals,undefined);assert.equal(r.report.broker_label,null);assert.equal(r.points.at(-1).profit,0);
});
test('owner-curated manual restore counts selected realized deals without magic but never bypasses normal Publisher validation',()=>{
 const p=payload();
 const restore=(id,time,entry,profit,position)=>({id:String(id),time,type:entry===0?0:1,entry,magic:null,position,volume:1,profit,commission:0,swap:0,fee:0,restore_batch_id:'HELIX_REAL_257471789_DEAL_RECON_2026-10-01_to_20_LOT1_FINAL',restore_owner_selected:true});
 p.deals=[restore(10,'2026.10.01 09:00:00',0,0,'501'),restore(11,'2026.10.01 10:00:00',1,20,'501'),restore(12,'2026.10.01 11:00:00',1,5,null),deal(13,0,0,{time:'2026.10.05 12:00:00',position:'502',volume:.1,magic:681001}),deal(14,1,-6,{time:'2026.10.05 12:01:00',position:'502',volume:.1,entry:1,magic:681001})];
 p.deals[2].entry=1;p.deals[2].type=1;
 const r=calculate(p,now);
 assert.equal(r.report.net_profit,19,'the exact-1-lot owner restore plus future verified deals are both accumulated');
 assert.equal(r.report.total_trades,2);assert.equal(r.report.win_rate,50);assert.equal(r.report.profit_factor,3.33);
 assert.equal(r.report.provenance,'owner_curated_manual_restore');assert.equal(r.report.magic_unverified_deal_count,3);
 assert.equal(r.report.trade_metrics_scope,'fully_mapped_closed_positions_only');assert.equal(r.report.excluded_unmapped_deal_count,1);
 assert.equal(r.report.period_start,'2026-10-01T00:00:00Z');
 assert.throws(()=>validateIncoming(p,now),'manual restore exception is not available to normal MT5 publisher requests');
});
test('broker archival keeps 100 captured deals plus 20 new deals; smaller later window never erases history',()=>{
 const makePosition=(n,day='05',profit=10)=>[
  deal(n*2,0,0,{position:String(n),time:`2026.10.${day} 10:00:00`,entry:0}),
  deal(n*2+1,1,profit,{position:String(n),time:`2026.10.${day} 10:01:00`,entry:1}),
 ];
 const p=payload();p.deals=Array.from({length:50},(_,i)=>makePosition(i+1)).flat();
 const first=validateIncoming(p,now);let ledger=mergeDealLedger([],first);assert.equal(ledger.length,100);
 const delta=payload();delta.recorded_at_unix=now/1000+600;delta.broker_now='2026.10.10 10:10:00';delta.deals=Array.from({length:10},(_,i)=>makePosition(i+51,'10')).flat();
 ledger=mergeDealLedger(ledger,validateIncoming(delta,now+600000));assert.equal(ledger.length,120);
 const archived=payload();archived.recorded_at_unix=now/1000+1200;archived.broker_now='2026.10.10 10:20:00';archived.deals=[...delta.deals,{id:'999999',time:'2026.10.10 10:15:00',type:2,entry:0,magic:0,profit:999999,commission:0,swap:0,fee:0}];
 const fresh=validateIncoming(archived,now+1200000);assert.equal(fresh.length,20,'balance/archive correction is excluded from P/L ledger');
 ledger=mergeDealLedger(ledger,fresh);assert.equal(ledger.length,120,'smaller broker window does not delete the original 100');
 const cumulative=calculate({...archived,deals:ledger},now+1200000,1000);
 assert.equal(cumulative.report.net_profit,600);assert.equal(cumulative.report.total_trades,60);assert.equal(cumulative.points.at(-1).profit,600);
 assert.ok(ledger.some(d=>d.id==='2')&&ledger.some(d=>d.id==='100'),'old deal tickets remain persisted in the accumulated ledger');
});
