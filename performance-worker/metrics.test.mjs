import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate} from './metrics.mjs';
const now=Date.parse('2026-10-10T08:00:00Z');
const deal=(id,type,profit,extra={})=>({id:String(id),time:'2026.10.05 10:00:00',type,entry:0,position:'10',volume:.01,profit,commission:0,swap:0,fee:0,...extra});
const payload=()=>({version:2,history_from:'2026.10.04 00:00:00',broker_now:'2026.10.10 10:00:00',recorded_at_unix:now/1000,account_type:'real',account_login:'123456',broker:'TEST-SERVER',currency:'USD',symbol:'XAUUSDm',balance:1106,equity:1105,credit:0,deals:[deal(1,2,1000),deal(2,0,0,{commission:-2}),deal(3,1,10,{entry:1,commission:-2}),deal(4,2,100)]});
test('cash flows excluded; entry/exit costs included; initial balance and monthly history reconcile',()=>{
 const r=calculate(payload(),now);assert.equal(r.report.net_profit,6);assert.equal(r.report.initial_balance,0);assert.equal(r.cashflow,1100);assert.equal(r.report.total_trades,1);assert.equal(r.report.win_rate,100);assert.equal(r.report.profit_factor,null);assert.equal(r.monthly[0].change,6);assert.equal(r.balance_points.at(-1).balance,1106);assert.deepEqual(r.points,[]);
});
test('partial close does not count position as complete',()=>{
 const p=payload();p.deals[2].volume=.005;assert.equal(calculate(p,now).report.total_trades,0);
});
test('withdrawals are not trading losses',()=>{
 const p=payload();p.deals.push(deal(5,2,-200));p.balance-=200;const r=calculate(p,now);assert.equal(r.report.net_profit,6);assert.equal(r.cashflow,900);
});
test('losing position includes entry fees and computes profit factor',()=>{
 const p=payload();p.deals.push(deal(5,0,0,{position:'20',commission:-2}),deal(6,1,1,{position:'20',entry:1,commission:-2}));p.balance-=3;const r=calculate(p,now);assert.equal(r.report.win_rate,50);assert.equal(r.report.profit_factor,2);assert.equal(r.report.net_profit,3);
});
test('reject duplicates, demo, wrong date, stale clock, unsupported credit and missing entry',()=>{
 for(const modify of [p=>p.deals.push(p.deals[0]),p=>p.account_type='demo',p=>p.history_from='2026.01.01 00:00:00',p=>p.recorded_at_unix-=3600,p=>p.credit=100,p=>p.deals.splice(1,1)]){const p=payload();modify(p);assert.throws(()=>calculate(p,now));}
});
test('public data contains no account login, deal IDs, position IDs or raw history',()=>{
 const r=calculate(payload(),now);assert.equal(r.account_login,undefined);assert.equal(r.deals,undefined);assert.equal(r.report.broker_label,null);
});
