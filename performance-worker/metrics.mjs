export const START = '2026.10.04 00:00:00';
export const RESTORE_START = '2026.10.01 00:00:00';
export const RESTORE_BATCH_ID = 'HELIX_REAL_257471789_DEAL_RECON_2026-10-01_to_20_LOT1_FINAL';
const round = x => Math.round((x + Number.EPSILON) * 100) / 100;
const fail = message => { throw new Error(message); };
const numeric = (x, min = -1e10, max = 1e10) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const brokerDate = value => {
  if (typeof value !== 'string' || !/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail('Invalid broker time');
  const iso = value.replaceAll('.', '-').replace(' ', 'T') + 'Z';
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0,19) !== iso.slice(0,19)) fail('Invalid date');
  return iso;
};
const isHelix = magic => Number.isSafeInteger(magic) && magic >= 681000 && magic <= 681999;
function validateEnvelope(p, now, maxDeals, allowOwnerRestore = false) {
  if (!p || p.version !== 3 || p.scope !== 'helix_magic_681') fail('Update to HELIX Publisher V3 (magic-filtered profit)');
  if (p.history_from !== START || p.account_type !== 'real') fail('Expected real account and agreed start date');
  // Keep the historic broker string byte-for-byte for salted account identity;
  // reject ambiguous surrounding whitespace/control characters instead of normalizing it.
  if (typeof p.account_login !== 'string' || !/^[0-9]{3,18}$/.test(p.account_login) || typeof p.broker !== 'string' || !p.broker.length || p.broker.length > 100 || p.broker !== p.broker.trim() || /[\u0000-\u001f\u007f]/.test(p.broker)) fail('Invalid account');
  if (!/^[A-Z]{3,6}$/.test(p.currency) || !/^[\w.\-]{2,30}$/.test(p.symbol)) fail('Invalid currency/symbol');
  if (!Number.isInteger(p.recorded_at_unix) || Math.abs(now-p.recorded_at_unix*1000) > 15*60*1000) fail('VPS UTC clock is incorrect');
  const start = brokerDate(p.history_from), restoreStart = brokerDate(RESTORE_START), end = brokerDate(p.broker_now);
  if (end < start || Math.abs(Date.parse(end)-now) > 4*86400000) fail('Invalid broker clock');
  if (!Array.isArray(p.deals) || p.deals.length > maxDeals) fail('Too many deals');
  let effectiveStart = start, hasRestoredRows=false;
  const ids = new Set();
  for (const d of p.deals) {
    const restored = allowOwnerRestore && d?.restore_batch_id === RESTORE_BATCH_ID;
    if (!d || typeof d.id !== 'string' || !/^[0-9]{1,20}$/.test(d.id) || ids.has(d.id)) fail('Invalid or duplicate deal');
    ids.add(d.id);
    const time = brokerDate(d.time);
    if (time < (restored ? restoreStart : start) || time > end) fail('Deal outside history period');
    if ((!Number.isSafeInteger(d.magic) || d.magic < 0) && !(restored && d.magic === null)) fail('Missing or invalid magic');
    if (restored && (d.restore_owner_selected !== true || d.volume !== 1 || (d.position !== null && (typeof d.position !== 'string' || !/^[1-9][0-9]{0,19}$/.test(d.position))))) fail('Invalid owner-curated restore record');
    if (restored) {hasRestoredRows=true;effectiveStart=restoreStart;}
    if (!Number.isInteger(d.type) || d.type < 0) fail('Invalid deal type');
    // Broker balance/correction/archive rows are validated for identity and time,
    // but never enter the strategy P/L ledger.
    if (d.type !== 0 && d.type !== 1) continue;
    if ((!restored && (typeof d.position !== 'string' || !/^[1-9][0-9]{0,19}$/.test(d.position))) || ![0,1,2,3].includes(d.entry) || !numeric(d.volume,.00000001,1e6)) fail('Invalid position');
    for (const key of ['profit','commission','swap','fee']) if (!numeric(d[key])) fail('Invalid deal amount');
  }
  return {start:hasRestoredRows?restoreStart:effectiveStart,end};
}

// Validate a sync without requiring that the current broker window still
// contains every earlier deal in each position. Completeness is checked after
// merging with the persistent server-side ledger.
export function validateIncoming(p, now = Date.now()) {
  validateEnvelope(p, now, 15000);
  return p.deals.filter(d => d.type === 0 || d.type === 1);
}

// Pure equivalent of the D1 ledger's (account_hash, deal_ticket) upsert: absence
// from a later broker window never deletes an earlier captured strategy deal.
export function mergeDealLedger(previous, incoming) {
  const byId = new Map(previous.map(d => [d.id, d]));
  for (const d of incoming) if (d.type === 0 || d.type === 1) byId.set(d.id, d);
  return [...byId.values()];
}

export function calculate(p, now = Date.now(), maxDeals = 15000) {
  const {start,end} = validateEnvelope(p, now, maxDeals, true);
  const restored = p.deals.some(d=>d.restore_batch_id===RESTORE_BATCH_ID);
  const selected = restored ? p.deals.filter(d=>d.volume===1) : p.deals;
  const positions = new Map(), events = [];
  let net=0, wins=0, trades=0, grossProfit=0, grossLoss=0, incompleteTradeMapping=false;
  for (const d of selected) {
    if (d.type !== 0 && d.type !== 1) continue;
    const time = brokerDate(d.time);
    if (restored) {
      // Owner-curated restore P/L is deal-based and deduped by ticket. This
      // preserves realized exits whose opening position predates the exports.
      const change=d.profit+d.commission+d.swap+d.fee;
      net+=change;events.push({time,change,id:d.id});
      if (d.restore_batch_id===RESTORE_BATCH_ID && d.position===null) incompleteTradeMapping=true;
    }
    if (d.restore_batch_id===RESTORE_BATCH_ID && d.position===null) {
      continue;
    }
    const deals = positions.get(d.position) || [];
    deals.push({...d,time}); positions.set(d.position,deals);
  }
  for (const deals of positions.values()) {
    deals.sort((a,b)=>a.time.localeCompare(b.time) || (BigInt(a.id)<BigInt(b.id)?-1:1));
    const entries=deals.filter(d=>d.entry===0 || d.entry===2);
    const isRestore=d=>d.restore_batch_id===RESTORE_BATCH_ID;
    const owned=entries.some(d=>isHelix(d.magic)||isRestore(d)) || (restored && deals.some(isRestore));
    if (!owned) {
      if (deals.some(d=>isHelix(d.magic))) fail('HELIX exit has no matching entry; history incomplete or mixed position');
      continue;
    }
    if (entries.some(d=>!isHelix(d.magic)&&!isRestore(d)) || (deals[0].entry!==0 && !isRestore(deals[0])) || (!isHelix(deals[0].magic)&&!isRestore(deals[0]))) fail('Mixed manual/EA netting position or missing entry; cannot attribute safely');
    if (restored && deals.some(isRestore) && entries.length===0) incompleteTradeMapping=true;
    let pnl=0,volume=0;
    for (const d of deals) {
      const change=d.profit+d.commission+d.swap+d.fee;
      pnl+=change;if(!restored){net+=change;events.push({time:d.time,change,id:d.id});}volume+=d.volume*(d.type===0?1:-1);
    }
    if (Math.abs(volume)<1e-7) {
      trades++;
      if(pnl>.000001){wins++;grossProfit+=pnl;}else if(pnl<-.000001)grossLoss-=pnl;
    } else if (deals.some(isRestore)) incompleteTradeMapping=true;
  }
  events.sort((a,b)=>a.time.localeCompare(b.time) || (BigInt(a.id)<BigInt(b.id)?-1:1));
  const daily=new Map(), monthly=new Map();let profit=0;
  for(const e of events){profit+=e.change;daily.set(e.time.slice(0,10),round(profit));const month=e.time.slice(0,7);monthly.set(month,(monthly.get(month)||0)+e.change);}
  const points=[{recorded_at:start,balance:null,equity:null,profit:0},...[...daily].map(([day,value])=>({recorded_at:day+'T23:59:59Z',balance:null,equity:null,profit:value}))];
  if(points.at(-1).recorded_at>end)points.at(-1).recorded_at=end;
  if(points.at(-1).recorded_at<end)points.push({recorded_at:end,balance:null,equity:null,profit:round(net)});
  const unknownMagic=selected.filter(d=>d.restore_batch_id===RESTORE_BATCH_ID&&d.magic===null).length;
  const restoredCount=restored?418:0;
  return {
    scope:'helix_magic_681',schema_version:3,chart_basis:'profit',
    report:{series_slug:'quadriga',kind:'live',label:'HELIX QUADRIGA',account_type:'real',broker_label:null,currency:p.currency,symbol:p.symbol,initial_balance:null,net_profit:round(net),win_rate:incompleteTradeMapping?null:trades?round(wins/trades*100):null,profit_factor:incompleteTradeMapping?null:grossLoss?round(grossProfit/grossLoss):null,max_drawdown_pct:null,total_trades:incompleteTradeMapping?null:trades,period_start:start,period_end:end,updated_at:new Date(p.recorded_at_unix*1000).toISOString(),...(restored?{provenance:'owner_curated_manual_restore',selection_filter:'deal_volume_1.00_lot',restore_batch_id:RESTORE_BATCH_ID,restored_deal_count:restoredCount,magic_unverified_deal_count:unknownMagic,trade_metrics_complete:!incompleteTradeMapping}: {})},
    monthly:[...monthly].map(([month,change])=>({month,change:round(change)})),points,
  };
}
