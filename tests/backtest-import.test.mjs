import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTesterLog } from '../scripts/import-backtest.mjs';

test('tester log is reconciled to report dates, currency, final balance, and tick-quality gaps', () => {
  const report = {
    period_start: '2026-01-01T00:00:00Z', period_end: '2026-10-17T00:00:00Z',
    currency: 'USD', initial_balance: 5000, net_profit: 30452.01,
  };
  const log = String.raw`Tester testing of Experts\HELIX_QUADRIGA_v1.9b_Live.ex5 from 2026.01.01 00:00 to 2026.10.17 00:00
initial deposit 5000.00 USD
final balance 35452.01 USD
XAUUSDc,M1: 77418965 ticks, 281210 bars generated.
real ticks absent for 1258 minutes of 281210 total minute bars, every tick generation used
real ticks absent for 1 whole days`;
  const result = parseTesterLog(log, report);
  assert.equal(result.expert_file, 'HELIX_QUADRIGA_v1.9b_Live.ex5');
  assert.equal(result.final_balance, 35452.01);
  assert.equal(result.ticks, 77418965);
  assert.equal(result.bars, 281210);
  assert.equal(result.real_ticks_missing_minutes, 1258);
  assert.equal(result.real_ticks_missing_days, 1);
  assert.throws(() => parseTesterLog(log, {...report, net_profit: 10}), /do not match/);
});
