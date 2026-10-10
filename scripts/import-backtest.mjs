import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const clean = s => s.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').trim();
const number = s => {
  const normalized = s.replace(/\s/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) throw new Error(`Invalid number: ${s}`);
  return Number(normalized);
};
const date = s => s.replaceAll('.', '-') + 'T00:00:00Z';
export function parseReport(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => clean(c[1])));
  const field = name => {
    for (const row of rows) { const i = row.indexOf(name + ':'); if (i >= 0 && row[i+1]) return row[i+1]; }
    throw new Error(`Missing field: ${name}`);
  };
  if (!field('Expert').includes('HELIX_QUADRIGA')) throw new Error('Expected a HELIX QUADRIGA report');
  const period = field('Period').match(/^(\S+) \((\d{4}\.\d{2}\.\d{2}) - (\d{4}\.\d{2}\.\d{2})\)$/);
  if (!period) throw new Error('Unsupported period format');
  const start = date(period[2]), end = date(period[3]);
  if (!Number.isFinite(Date.parse(start)) || Date.parse(end) < Date.parse(start)) throw new Error('Invalid period');
  const initial = number(field('Initial Deposit')), profit = number(field('Total Net Profit'));
  const header = rows.findIndex(r => r[0] === 'Time' && r.includes('Deal') && r.includes('Balance'));
  if (header < 0) throw new Error('Missing Deals table');
  const columns = rows[header];
  const daily = new Map();
  let finalBalance = initial, sum = 0, deposits = 0, deals = 0;
  for (const row of rows.slice(header + 1)) {
    if (!/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(row[0])) continue;
    const get = name => row[columns.indexOf(name)];
    const day = date(row[0].slice(0,10));
    if (day < start || day > end) throw new Error('Deal outside test period');
    finalBalance = number(get('Balance'));
    if (get('Type') === 'balance') {
      deposits++;
      if (deposits !== 1 || number(get('Profit')) !== initial || deals) throw new Error('Additional cash flows need manual review');
    } else {
      if (!['buy','sell'].includes(get('Type'))) throw new Error('Unsupported deal type');
      sum += number(get('Profit')) + number(get('Commission')) + number(get('Swap'));
      deals++;
    }
    // Preserve report accounting order, which can differ from execution timestamps.
    daily.set(day, finalBalance);
  }
  if (deposits !== 1 || deals !== number(field('Total Deals')) || Math.abs(sum-profit) > .02 || Math.abs(finalBalance-initial-profit) > .02) throw new Error('Deals do not reconcile with report totals');
  const percent = value => { const m = value.match(/([\d.]+)%/); if (!m) throw new Error('Missing percentage'); return number(m[1]); };
  const winRate = percent(field('Profit Trades (% of total)')), dd = percent(field('Equity Drawdown Relative'));
  if (winRate > 100 || dd > 100) throw new Error('Invalid percentage');
  const points = [{recorded_at:start,balance:initial,equity:null}, ...[...daily].sort(([a],[b]) => a.localeCompare(b)).map(([day,balance]) => ({recorded_at:day.replace('00:00:00','23:59:59'),balance,equity:null}))];
  return {
    report: {series_slug:'quadriga',kind:'backtest',label:'HELIX QUADRIGA',account_type:'backtest',broker_label:field('Company'),currency:field('Currency'),symbol:field('Symbol'),initial_balance:initial,net_profit:profit,win_rate:winRate,profit_factor:number(field('Profit Factor')),max_drawdown_pct:dd,total_trades:number(field('Total Trades')),period_start:start,period_end:end,updated_at:new Date().toISOString()},
    chart_basis:'balance',timeframe:period[1],history_quality:field('History Quality'),points,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: npm run import:backtest -- "path/to/report.html"');
  const bytes = await readFile(process.argv[2]);
  const html = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8');
  const data = parseReport(html);
  const target = new URL('../lib/backtest-data.json', import.meta.url);
  const temp = new URL('../lib/backtest-data.json.tmp', import.meta.url);
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n');
  await rename(temp, target);
  console.log(JSON.stringify({status:'Imported (replaces previous report)',...data.report,points:data.points.length},null,2));
}
