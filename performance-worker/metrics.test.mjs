import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate} from './metrics.mjs';
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
