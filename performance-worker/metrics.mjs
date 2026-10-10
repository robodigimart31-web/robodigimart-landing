export const START = '2026.10.04 00:00:00';
const round = x => Math.round((x + Number.EPSILON) * 100) / 100;
const fail = message => { throw new Error(message); };
const numeric = (x, min = -1e10, max = 1e10) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const brokerDate = value => {
  if (typeof value !== 'string' || !/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail('Invalid broker time');
  const iso = value.replaceAll('.', '-').replace(' ', 'T') + 'Z';
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0,19) !== iso.slice(0,19)) fail('Invalid date');
  return iso;
};
export function calculate(p, now = Date.now()) {
  if (!p || p.version !== 2 || p.history_from !== START || p.account_type !== 'real') fail('Expected real account and agreed start date');
  if (!/^[0-9]{3,18}$/.test(p.account_login) || typeof p.broker !== 'string' || !p.broker.length || p.broker.length > 100) fail('Invalid account');
  if (!/^[A-Z]{3,6}$/.test(p.currency) || !/^[\w.\-]{2,30}$/.test(p.symbol)) fail('Invalid currency/symbol');
  if (!numeric(p.balance) || !numeric(p.equity) || p.credit !== 0) fail('Invalid balance/equity or unsupported broker credit');
  if (!Number.isInteger(p.recorded_at_unix) || Math.abs(now-p.recorded_at_unix*1000) > 15*60*1000) fail('VPS UTC clock is incorrect');
  const start = brokerDate(p.history_from), end = brokerDate(p.broker_now);
  if (end < start || Math.abs(Date.parse(end)-now) > 4*86400000) fail('Invalid broker clock');
  if (!Array.isArray(p.deals) || p.deals.length > 15000) fail('Too many deals');
  const ids = new Set(); const positions = new Map(); const events = [];
  let totalChange = 0, cashflow = 0, net = 0;
  for (const d of p.deals) {
    if (typeof d.id !== 'string' || !/^[0-9]{1,20}$/.test(d.id) || ids.has(d.id)) fail('Invalid or duplicate deal');
    ids.add(d.id);
    const time = brokerDate(d.time);
    if (time < start || time > end) fail('Deal outside history period');
    if (![0,1,2,4,7,8,9,10,11,12,15,16,17].includes(d.type)) fail('Unsupported balance operation: manual review required');
    for (const key of ['profit','commission','swap','fee']) if (!numeric(d[key])) fail('Invalid deal amount');
    const change = d.profit+d.commission+d.swap+d.fee;
    totalChange += change;
    if (d.type === 2) cashflow += change; else net += change;
    events.push({time,change,pnl:d.type === 2 ? 0 : change,id:d.id});
    if (d.type === 0 || d.type === 1) {
      if (!/^[1-9][0-9]{0,19}$/.test(d.position) || ![0,1,2,3].includes(d.entry) || !numeric(d.volume, .00000001, 1e6)) fail('Invalid position');
      const pos = positions.get(d.position) || {pnl:0,volume:0,hasEntry:false};
      pos.pnl += change; pos.volume += d.volume * (d.type === 0 ? 1 : -1);
      if (d.entry === 0) pos.hasEntry = true;
      positions.set(d.position,pos);
    }
  }
  let initial = round(p.balance-totalChange);
  if (initial < -.02) fail('History does not reconcile with account balance');
  initial = Math.max(0,initial);
  let wins = 0, trades = 0, grossProfit = 0, grossLoss = 0;
  for (const pos of positions.values()) {
    if (!pos.hasEntry) fail('Missing entry history or a position predates start');
    if (Math.abs(pos.volume) < 1e-7) {
      trades++;
      if (pos.pnl > .000001) { wins++; grossProfit += pos.pnl; }
      else if (pos.pnl < -.000001) grossLoss -= pos.pnl;
    }
  }
  events.sort((a,b) => a.time.localeCompare(b.time) || (BigInt(a.id)<BigInt(b.id)?-1:1));
  const daily = new Map(), monthly = new Map(); let balance = initial;
  for (const e of events) {
    balance += e.change;
    daily.set(e.time.slice(0,10),round(balance));
    const month = e.time.slice(0,7);
    monthly.set(month,(monthly.get(month)||0)+e.pnl);
  }
  if (Math.abs(balance-p.balance) > .02) fail('Balance mismatch');
  const balancePoints = [{recorded_at:start,balance:initial,equity:null}, ...[...daily].map(([day,b])=>({recorded_at:day+'T23:59:59Z',balance:b,equity:null}))];
  // Broker timestamps are calendar labels only, not UTC instants.
  if (balancePoints.at(-1).recorded_at > end) balancePoints.at(-1).recorded_at = end;
  if (balancePoints.at(-1).recorded_at < end) balancePoints.push({recorded_at:end,balance:p.balance,equity:null});
  return {
    report:{series_slug:'quadriga',kind:'live',label:'HELIX QUADRIGA',account_type:'real',broker_label:null,currency:p.currency,symbol:p.symbol,initial_balance:initial,net_profit:round(net),win_rate:trades?round(wins/trades*100):null,profit_factor:grossLoss?round(grossProfit/grossLoss):null,max_drawdown_pct:null,total_trades:trades,period_start:start,period_end:end,updated_at:new Date(p.recorded_at_unix*1000).toISOString()},
    balance_points:balancePoints,monthly:[...monthly].map(([month,change])=>({month,change:round(change)})),cashflow:round(cashflow),points:[],
  };
}
