import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { test } from 'node:test';
import { onRequest } from '../functions/vip/api/[[path]].js';
import {
  buildStrategyEstimator,
  calculateLossDayStreak,
  estimateEndingEquity,
  ESTIMATOR_COMBINATIONS,
  ESTIMATOR_FAMILIES,
  ESTIMATOR_LOTS,
  parseEstimatorSelection,
} from '../functions/vip/api/strategy-estimator-model.js';
import { STRATEGY_ESTIMATOR_SOURCE } from '../functions/vip/api/strategy-estimator-source.js';

test('workbook snapshot contains the full calendar, 15 combinations, and 12 calibrated lots', () => {
  assert.equal(STRATEGY_ESTIMATOR_SOURCE.days.length, 293);
  assert.equal(ESTIMATOR_COMBINATIONS.length, 15);
  assert.equal(STRATEGY_ESTIMATOR_SOURCE.combinations.length, 15);
  assert.deepEqual(STRATEGY_ESTIMATOR_SOURCE.calibration.map(item => item.lot), ESTIMATOR_LOTS);
  assert.equal(STRATEGY_ESTIMATOR_SOURCE.days[0].date, '2026-01-01');
  assert.equal(STRATEGY_ESTIMATOR_SOURCE.days.at(-1).date, '2026-10-20');
  assert.match(STRATEGY_ESTIMATOR_SOURCE.sourceSha256, /^[a-f0-9]{64}$/);
});

test('default ALL / 0.01 regression snapshot reconciles to the workbook', () => {
  const result = buildStrategyEstimator({ lot: '0.01', families: [...ESTIMATOR_FAMILIES] });
  assert.equal(result.performance.closedTrades, 8542);
  assert.equal(result.performance.wins, 5961);
  assert.equal(result.performance.losses, 2581);
  assert.equal(result.performance.wins + result.performance.losses, result.performance.closedTrades);
  assert.equal(result.performance.winRate, 0.6978459377195037);
  assert.equal(result.performance.profitFactor, 2.2488164124145187);
  assert.equal(result.performance.peakOpen, 54);
  assert.equal(result.performance.netPips, 3100817.5);
  assert.equal(result.performance.netPnlUsd, 308.62);
  assert.equal(result.performance.positiveDays, 187);
  assert.equal(result.performance.negativeDays, 42);
  assert.equal(result.performance.daysWithClose, 229);
  assert.deepEqual(result.dailyRisk, {
    bestDay: { date: '2026-09-21', pnlUsd: 9.12 },
    worstDay: { date: '2026-10-01', pnlUsd: -2.57 },
    maxConsecutiveLossDays: 3,
    worstConsecutiveLossPnlUsd: -4.15,
  });
  assert.deepEqual(result.recommendedEquity, { opt1: 500, opt2: 500, opt3: 500 });
  assert.equal(result.daily.length, 293);
  assert.equal(result.daily[0].weeklyPnlUsd, 1.62);
  assert.equal(result.daily.at(-1).monthlyPnlUsd, 1.29);
  assert.equal(result.daily.at(-1).cumulativePnlUsd, 308.62);
  assert.equal(result.daily.find(day => day.date === '2026-01-03').dayStatus, 'NO TRADE');
  assert.equal(result.daily.find(day => day.date === '2026-01-03').winRate, null);
});

test('all 15 family subsets reconcile to 0.01-lot workbook summary and risk audit', () => {
  for (const combination of ESTIMATOR_COMBINATIONS) {
    const result = buildStrategyEstimator({ lot: '0.01', families: combination.split('+') });
    const workbook = STRATEGY_ESTIMATOR_SOURCE.combinations.find(item => item.name === combination) || STRATEGY_ESTIMATOR_SOURCE.combinations.find(item => item.name === 'ALL');
    assert.equal(result.performance.closedTrades, workbook.closedTrades, combination);
    assert.equal(result.performance.winRate, workbook.winRate, combination);
    assert.equal(result.performance.profitFactor, workbook.profitFactor, combination);
    assert.equal(result.performance.netPips, workbook.netPips, combination);
    assert.equal(result.dailyRisk.maxConsecutiveLossDays, workbook.maxLossDays, combination);
    assert.equal(result.dailyRisk.worstConsecutiveLossPnlUsd, -workbook.worstStreakLoss, combination);
    assert.equal(Math.round(Math.abs(result.daily.filter(day => day.closedTrades).reduce((worst, day) => Math.min(worst, day.pnlUsd), 0)) * 100) / 100, workbook.worstDailyLoss, combination);
  }
});

test('OPT1, OPT2, and OPT3 match the workbook formula output at lot 5 for every family subset', () => {
  const expected = [
    [5000, 3500, 3500], [11500, 8500, 7500], [11000, 8000, 7000], [3000, 2500, 2500], [5000, 3000, 3000],
    [11000, 8500, 7500], [10500, 8000, 7000], [1000, 1000, 500], [5000, 3500, 3500], [11500, 8500, 7500],
    [10500, 8000, 7000], [3000, 2500, 2500], [5000, 3000, 3000], [11500, 8500, 7500], [10500, 8000, 7000],
  ];
  ESTIMATOR_COMBINATIONS.forEach((combination, index) => {
    const result = buildStrategyEstimator({ lot: '5.00', families: combination.split('+') });
    assert.deepEqual([result.recommendedEquity.opt1, result.recommendedEquity.opt2, result.recommendedEquity.opt3], expected[index], combination);
  });
});

test('lot scaling matches every independent calibration total without rounding daily sums early', () => {
  for (const lot of ESTIMATOR_LOTS) {
    const result = buildStrategyEstimator({ lot, families: [...ESTIMATOR_FAMILIES] });
    const reference = STRATEGY_ESTIMATOR_SOURCE.calibration.find(item => item.lot === lot);
    assert.equal(result.performance.netPnlUsd, reference.netProfit, lot);
    assert.equal(result.daily.at(-1).cumulativePnlUsd, reference.netProfit, lot);
    assert.ok(result.recommendedEquity.opt1 >= 0 && result.recommendedEquity.opt2 >= 0 && result.recommendedEquity.opt3 >= 0);
  }
});

test('selection validation accepts each subset and rejects bad lots, duplicate families, and empty combinations', () => {
  for (const combination of ESTIMATOR_COMBINATIONS) {
    const selected = parseEstimatorSelection(new URLSearchParams({ lot: '0.01', families: combination.split('+').join(',') }));
    assert.deepEqual(selected, { lot: '0.01', families: combination.split('+') });
  }
  assert.equal(parseEstimatorSelection(new URLSearchParams({ lot: '0.04', families: 'ML' })), null);
  assert.equal(parseEstimatorSelection(new URLSearchParams({ lot: '0.01', families: 'ML,ML' })), null);
  assert.equal(parseEstimatorSelection(new URLSearchParams({ lot: '0.01', families: '' })), null);
  assert.equal(parseEstimatorSelection(new URLSearchParams({ lot: '0.01', families: 'ML,UNKNOWN' })), null);
});

test('loss-day streak skips no-trade dates and resets on a flat closed day', () => {
  const rows = [
    { closedTrades: 1, pnlUsd: -1 },
    { closedTrades: 0, pnlUsd: 0 },
    { closedTrades: 1, pnlUsd: -2 },
    { closedTrades: 1, pnlUsd: 0 },
    { closedTrades: 0, pnlUsd: 0 },
    { closedTrades: 1, pnlUsd: -4 },
    { closedTrades: 1, pnlUsd: -3 },
  ];
  assert.deepEqual(calculateLossDayStreak(rows), { maxLossDays: 2, worstStreakPnl: -7 });
});

test('starting equity is isolated from historical performance', () => {
  assert.equal(estimateEndingEquity(5000, 308.62), 5308.62);
  assert.equal(estimateEndingEquity(0, -4.15), -4.15);
  assert.equal(estimateEndingEquity(-1, 308.62), null);
  const base = buildStrategyEstimator({ lot: '0.01', families: [...ESTIMATOR_FAMILIES] });
  const withDifferentStartingEquity = buildStrategyEstimator({ lot: '0.01', families: [...ESTIMATOR_FAMILIES] });
  assert.deepEqual(withDifferentStartingEquity.performance, base.performance);
  assert.deepEqual(withDifferentStartingEquity.recommendedEquity, base.recommendedEquity);
});

test('authenticated estimator API denies anonymous and admin sessions and accepts member read-only GET', async t => {
  const originalFetch = globalThis.fetch;
  let role = 'member';
  let fetchCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls++;
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test' }), { status: 200 });
    if (target.includes('/rest/v1/helix_members?')) return new Response(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', role }]), { status: 200 });
    if (target.includes('/rest/v1/helix_member_suspensions?')) return new Response('[]', { status: 200 });
    if (target.includes('/rest/v1/rpc/helix_rate_limit')) return new Response(JSON.stringify({ allowed: true }), { status: 200 });
    throw new Error(`Unexpected fetch in API fixture: ${target} ${init.method || 'GET'}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'fixture-only', PAIRING_HASH_SECRET: 'a'.repeat(32) };
  const makeRequest = token => new Request('https://portal.test/vip/api/member/strategy-estimator?lot=0.01&families=ML,RL,SHL,LGL', { headers: token ? { authorization: `Bearer ${token}` } : {} });

  const anonymous = await onRequest({ request: makeRequest(null), env });
  assert.equal(anonymous.status, 401);
  assert.equal(fetchCalls, 0);

  role = 'admin';
  const admin = await onRequest({ request: makeRequest('admin-fixture'), env });
  assert.equal(admin.status, 403);
  assert.equal((await admin.json()).error, 'MEMBER_ACCESS_REQUIRED');

  role = 'member';
  const member = await onRequest({ request: makeRequest('member-fixture'), env });
  assert.equal(member.status, 200);
  assert.equal(member.headers.get('cache-control'), 'no-store');
  const result = await member.json();
  assert.equal(result.performance.netPnlUsd, 308.62);
  assert.equal(result.daily.length, 293);
});

test('page contains mandatory risk copy and source dataset is not a public asset', async () => {
  const page = await readFile(new URL('../public/vip/materials/strategy/helix-quadriga-estimator/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/vip/strategy-estimator.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/vip/strategy-estimator.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../functions/vip/api/[[path]].js', import.meta.url), 'utf8');
  assert.ok(page.indexOf('Peringatan Risiko dan Keterbatasan Simulasi') < page.indexOf('Atur simulasi'));
  assert.ok(page.includes('Performa Strategi &amp; Perkiraan Modal'));
  assert.ok(page.includes('Modal Awal (USD)'));
  assert.match(page, /id="strategy-gate"[^>]*hidden/);
  assert.ok(page.includes('Perdagangan dapat menyebabkan hilangnya sebagian atau seluruh modal'));
  assert.ok(css.includes('.strategy-page [hidden]{display:none!important}'));
  assert.ok(js.includes("showGate('strategy-app')"));
  assert.ok(js.includes("['Tingkat Kemenangan'"));
  assert.ok(js.includes("'Tanpa transaksi'"));
  assert.ok(js.includes("'1 strategi'" ) || js.includes("`${families.length} strategi`"));
  assert.ok(api.includes('MEMBER_ACCESS_REQUIRED'));
  assert.ok(!page.includes('OPT4'));
  await assert.rejects(access(new URL('../public/vip/strategy-estimator-source.js', import.meta.url)));
});

test('Admin Material form explains the HTTPS link field for create and edit', async () => {
  const admin = await readFile(new URL('../public/vip/admin/index.html', import.meta.url), 'utf8');
  assert.match(admin, /function addMaterialLinkHint\(form\)/);
  assert.match(admin, /Masukkan tautan halaman atau berkas pada kolom ini, bukan pada Deskripsi/);
  assert.match(admin, /previousMaterialModal/);
  assert.match(admin, /previousMaterialEdit/);
});
