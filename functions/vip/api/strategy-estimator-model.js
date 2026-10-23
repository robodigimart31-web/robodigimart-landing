import { STRATEGY_ESTIMATOR_SOURCE } from "./strategy-estimator-source.js";

export const ESTIMATOR_FAMILIES = Object.freeze(["ML", "RL", "SHL", "LGL"]);
export const ESTIMATOR_LOTS = Object.freeze(["0.01", "0.02", "0.03", "0.05", "0.10", "0.20", "0.30", "0.50", "1.00", "2.00", "3.00", "5.00"]);
export const ESTIMATOR_COMBINATIONS = Object.freeze(
  Array.from({ length: 16 }, (_, mask) => ESTIMATOR_FAMILIES.filter((_, index) => mask & (1 << index)).join("+"))
    .filter(Boolean),
);

const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const dateKey = date => date.toISOString().slice(0, 10);

export function parseEstimatorSelection(searchParams) {
  const lot = searchParams.get("lot");
  const rawFamilies = searchParams.get("families");
  const families = typeof rawFamilies === "string" ? rawFamilies.split(",") : [];
  if (!ESTIMATOR_LOTS.includes(lot) || !families.length || families.some(value => !ESTIMATOR_FAMILIES.includes(value))) return null;
  const normalized = ESTIMATOR_FAMILIES.filter(family => families.includes(family));
  if (normalized.length !== families.length || !ESTIMATOR_COMBINATIONS.includes(normalized.join("+"))) return null;
  return { lot, families: normalized };
}

export function calculateLossDayStreak(days) {
  let currentDays = 0;
  let currentPnl = 0;
  let maxLossDays = 0;
  let worstStreakPnl = 0;
  for (const day of days) {
    if (!day.closedTrades) continue;
    if (day.pnlUsd < 0) {
      currentDays++;
      currentPnl += day.pnlUsd;
      maxLossDays = Math.max(maxLossDays, currentDays);
      worstStreakPnl = Math.min(worstStreakPnl, currentPnl);
    } else {
      currentDays = 0;
      currentPnl = 0;
    }
  }
  return { maxLossDays, worstStreakPnl: money(worstStreakPnl) };
}

export function estimateEndingEquity(startEquity, netPnlUsd) {
  if (!Number.isFinite(startEquity) || startEquity < 0 || !Number.isFinite(netPnlUsd)) return null;
  return money(startEquity + netPnlUsd);
}

function assertSourceIntegrity(source) {
  if (source.days.length !== 293 || source.combinations.length !== 15 || source.calibration.length !== 12) throw new Error("ESTIMATOR_SOURCE_SHAPE_INVALID");
  if (source.families.join("+") !== ESTIMATOR_FAMILIES.join("+")) throw new Error("ESTIMATOR_SOURCE_FAMILIES_INVALID");
  const names = new Set(source.combinations.map(item => item.name));
  if (ESTIMATOR_COMBINATIONS.some(name => !names.has(name) && !(name === ESTIMATOR_FAMILIES.join("+") && names.has("ALL")))) throw new Error("ESTIMATOR_SOURCE_COMBINATIONS_INVALID");
  if (source.days[0]?.date !== "2026-01-01" || source.days.at(-1)?.date !== "2026-10-20") throw new Error("ESTIMATOR_SOURCE_PERIOD_INVALID");
  for (const day of source.days) {
    if (!/^2026-\d{2}-\d{2}$/.test(day.date) || day.families.length !== 4 || day.families.some(row => row.length !== 4 || row.some((value, index) => !Number.isFinite(value) || index < 3 && value < 0))) throw new Error("ESTIMATOR_SOURCE_DAILY_INVALID");
  }
  if (source.calibration.some(item => !ESTIMATOR_LOTS.includes(item.lot)) || ESTIMATOR_LOTS.some(lot => !source.calibration.some(item => item.lot === lot))) throw new Error("ESTIMATOR_SOURCE_LOTS_INVALID");
}

assertSourceIntegrity(STRATEGY_ESTIMATOR_SOURCE);

function ceiledStress(value, increment) {
  return Math.ceil((value - Number.EPSILON * Math.max(1, Math.abs(value))) / increment) * increment;
}

export function buildStrategyEstimator({ lot, families }, source = STRATEGY_ESTIMATOR_SOURCE) {
  const comboName = families.join("+");
  const summary = source.combinations.find(item => item.name === comboName) || (comboName === ESTIMATOR_FAMILIES.join("+") ? source.combinations.find(item => item.name === "ALL") : null);
  const calibration = source.calibration.find(item => item.lot === lot);
  if (!summary || !calibration) throw new Error("ESTIMATOR_SELECTION_NOT_FOUND");
  const lotNumber = Number(lot);
  const scale = calibration.netProfit / source.calibration.find(item => item.lot === source.assumptions.baseLot.toFixed(2)).netProfit;
  const indexes = families.map(family => ESTIMATOR_FAMILIES.indexOf(family));
  const rows = source.days.map(sourceDay => {
    let wins = 0, losses = 0, closedTrades = 0, basePnl = 0;
    for (const index of indexes) {
      const family = sourceDay.families[index];
      closedTrades += family[0];
      wins += family[1];
      losses += family[2];
      basePnl += family[3];
    }
    return {
      date: sourceDay.date,
      day: new Date(`${sourceDay.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
      wins,
      losses,
      closedTrades,
      winRate: closedTrades ? wins / closedTrades : null,
      pnlUsd: basePnl * scale,
      cumulativePnlUsd: 0,
      dayStatus: !closedTrades ? "NO TRADE" : basePnl < 0 ? "NEGATIVE" : basePnl > 0 ? "POSITIVE" : "FLAT",
      weeklyPnlUsd: 0,
      weekStatus: "FLAT",
      monthlyPnlUsd: 0,
      monthStatus: "FLAT",
    };
  });

  let cumulative = 0;
  const weekly = new Map(), monthly = new Map();
  for (const row of rows) {
    cumulative += row.pnlUsd;
    row.cumulativePnlUsd = money(cumulative);
    const date = new Date(`${row.date}T00:00:00Z`);
    const weekStart = new Date(date);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    const weekKey = dateKey(weekStart);
    const monthKey = row.date.slice(0, 7);
    weekly.set(weekKey, (weekly.get(weekKey) || 0) + row.pnlUsd);
    monthly.set(monthKey, (monthly.get(monthKey) || 0) + row.pnlUsd);
  }
  for (const row of rows) {
    const date = new Date(`${row.date}T00:00:00Z`);
    const weekStart = new Date(date);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    row.weeklyPnlUsd = money(weekly.get(dateKey(weekStart)) || 0);
    row.weekStatus = row.weeklyPnlUsd < 0 ? "NEGATIVE" : row.weeklyPnlUsd > 0 ? "POSITIVE" : "FLAT";
    row.monthlyPnlUsd = money(monthly.get(row.date.slice(0, 7)) || 0);
    row.monthStatus = row.monthlyPnlUsd < 0 ? "NEGATIVE" : row.monthlyPnlUsd > 0 ? "POSITIVE" : "FLAT";
  }

  const stats = {
    closedTrades: rows.reduce((total, row) => total + row.closedTrades, 0),
    wins: rows.reduce((total, row) => total + row.wins, 0),
    losses: rows.reduce((total, row) => total + row.losses, 0),
    netPnlUsd: money(rows.reduce((total, row) => total + row.pnlUsd, 0)),
    positiveDays: rows.filter(row => row.closedTrades && row.pnlUsd > 0).length,
    negativeDays: rows.filter(row => row.closedTrades && row.pnlUsd < 0).length,
    daysWithClose: rows.filter(row => row.closedTrades > 0).length,
  };
  const closedDays = rows.filter(row => row.closedTrades > 0);
  const bestDay = closedDays.reduce((best, row) => !best || row.pnlUsd > best.pnlUsd ? row : best, null);
  const worstDay = closedDays.reduce((worst, row) => !worst || row.pnlUsd < worst.pnlUsd ? row : worst, null);
  const streak = calculateLossDayStreak(rows);
  const assumptions = source.assumptions;
  const equityDrawdown = summary.realizedDrawdownPips * lotNumber * assumptions.pnlMultiplier * assumptions.equityDdMultiplier / 100;
  const peakMargin = summary.peakOpen * lotNumber * assumptions.xauPrice * assumptions.pnlMultiplier / assumptions.leverage;
  const recommendations = {
    opt1: ceiledStress((equityDrawdown + assumptions.marginLevel * peakMargin) * (1 + assumptions.buffer), assumptions.roundUp),
    opt2: ceiledStress((Math.abs(streak.worstStreakPnl) + assumptions.marginLevel * peakMargin) * (1 + assumptions.buffer), assumptions.roundUp),
    opt3: ceiledStress((Math.abs(Math.min(0, ...closedDays.map(row => row.pnlUsd))) + assumptions.marginLevel * peakMargin) * (1 + assumptions.buffer), assumptions.roundUp),
  };

  if (stats.closedTrades !== summary.closedTrades || stats.wins + stats.losses !== stats.closedTrades) throw new Error("ESTIMATOR_SOURCE_TRADE_RECONCILIATION_FAILED");
  if (summary.name === "ALL" && lot === "0.01" && (stats.closedTrades !== 8542 || stats.wins !== 5961 || stats.losses !== 2581 || stats.netPnlUsd !== 308.62 || stats.positiveDays !== 187 || stats.negativeDays !== 42 || streak.maxLossDays !== 3 || streak.worstStreakPnl !== -4.15)) throw new Error("ESTIMATOR_SOURCE_REGRESSION_FAILED");

  return {
    source: source.source,
    period: source.period,
    lot,
    families,
    combination: summary.name,
    lotScaleVsBase: scale,
    referenceMetricsNote: "Win Rate, Profit Factor, Peak Open, dan Net Pips memakai eksekusi family-tagged historis 0,01 lot. Kombinasi family bukan backtest independen.",
    performance: { winRate: summary.winRate, profitFactor: summary.profitFactor, peakOpen: summary.peakOpen, netPips: summary.netPips, ...stats },
    dailyRisk: {
      bestDay: bestDay ? { date: bestDay.date, pnlUsd: money(bestDay.pnlUsd) } : null,
      worstDay: worstDay ? { date: worstDay.date, pnlUsd: money(worstDay.pnlUsd) } : null,
      maxConsecutiveLossDays: streak.maxLossDays,
      worstConsecutiveLossPnlUsd: money(streak.worstStreakPnl),
    },
    recommendedEquity: recommendations,
    daily: rows,
  };
}
