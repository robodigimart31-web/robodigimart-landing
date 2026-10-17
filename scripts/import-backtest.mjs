import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
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
  const detailFields = [
    'Bars','Ticks','Symbols','Gross Profit','Gross Loss','Balance Drawdown Absolute','Balance Drawdown Maximal','Balance Drawdown Relative',
    'Equity Drawdown Absolute','Equity Drawdown Maximal','Equity Drawdown Relative','Expected Payoff','Margin Level','Recovery Factor',
    'Sharpe Ratio','Z-Score','AHPR','GHPR','LR Correlation','OnTester result','LR Standard Error','Total Deals',
    'Short Trades (won %)','Long Trades (won %)','Profit Trades (% of total)','Loss Trades (% of total)','Largest profit trade','Largest loss trade',
    'Average profit trade','Average loss trade','Maximum consecutive wins ($)','Maximum consecutive losses ($)',
    'Maximal consecutive profit (count)','Maximal consecutive loss (count)','Average consecutive wins','Average consecutive losses',
    'Leverage','Expert',
  ];
  const details = Object.fromEntries(detailFields.map(name => [name, field(name)]));
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
    chart_basis:'balance',timeframe:period[1],history_quality:field('History Quality'),details,points,
  };
}
export function parseTesterLog(log, report) {
  const run = log.match(/testing of Experts\\([^\s]+) from (\d{4}\.\d{2}\.\d{2}) 00:00 to (\d{4}\.\d{2}\.\d{2}) 00:00/);
  const final = log.match(/final balance ([\d ]+(?:\.\d+)?) ([A-Z]{3})/);
  const generated = log.match(/: ([\d ]+) ticks, ([\d ]+) bars generated/);
  const missing = log.match(/real ticks absent for (\d+) minutes of ([\d ]+) total minute bars, every tick generation used/);
  const missingDays = log.match(/real ticks absent for (\d+) whole days/);
  if (!run || !final || !generated) throw new Error('Tester log is missing run dates, final balance, or generated tick/bar totals');
  const start = date(run[2]), end = date(run[3]), finalBalance = number(final[1]);
  if (start !== report.period_start || end !== report.period_end || final[2] !== report.currency || Math.abs(finalBalance - report.initial_balance - report.net_profit) > .02) {
    throw new Error('Tester log run dates or final balance do not match the HTML report');
  }
  return {
    expert_file: run[1], final_balance: finalBalance, currency: final[2], ticks: number(generated[1]), bars: number(generated[2]),
    real_ticks_missing_minutes: missing ? Number(missing[1]) : 0,
    minute_bars_with_missing_tick_detail: missing ? number(missing[2]) : null,
    real_ticks_missing_days: missingDays ? Number(missingDays[1]) : 0,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: npm run import:backtest -- "path/to/report.html" ["path/to/tester.log"]');
  const bytes = await readFile(process.argv[2]);
  const html = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8');
  const data = parseReport(html);
  if (process.argv[3]) {
    const logBytes = await readFile(process.argv[3]);
    const testerLog = logBytes.toString(logBytes[0] === 255 && logBytes[1] === 254 ? 'utf16le' : 'utf8');
    data.tester_log = parseTesterLog(testerLog, data.report);
  }
  // Import only the supplementary charts belonging to this report. Never reuse
  // charts from an older test when a new HTML report arrives without its PNGs.
  const reportPath = path.resolve(process.argv[2]);
  const stem = path.basename(reportPath, path.extname(reportPath));
  const diagnostics = {};
  for (const [key, suffix] of [['distribution','hst'],['correlation','mfemae'],['holding','holding']]) {
    const imagePath = path.join(path.dirname(reportPath), `${stem}-${suffix}.png`);
    let bytes;
    try { bytes = await readFile(imagePath); } catch(error) { if(error.code === 'ENOENT') continue; throw error; }
    const meta = await sharp(bytes).metadata();
    if(meta.format !== 'png' || !meta.width || !meta.height) throw new Error('Invalid report chart PNG');
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0,12);
    const filename = `quadriga-${suffix}-${hash}.png`;
    const folder = new URL('../public/images/backtest/', import.meta.url);
    await mkdir(folder,{recursive:true});
    await writeFile(new URL(filename,folder),bytes);
    diagnostics[key] = {src:`/images/backtest/${filename}`,width:meta.width,height:meta.height};
  }
  data.diagnostics = diagnostics;
  const target = new URL('../lib/backtest-data.json', import.meta.url);
  const temp = new URL('../lib/backtest-data.json.tmp', import.meta.url);
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n');
  await rename(temp, target);
  console.log(JSON.stringify({status:'Imported (replaces previous report)',...data.report,points:data.points.length},null,2));
}
