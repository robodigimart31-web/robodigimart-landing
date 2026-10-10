import "server-only";
import { dbRequest } from "@/lib/supabase-rest";
import type { PerformanceDataset, PerformanceKind, PerformancePoint, PerformanceReport } from "@/lib/performance-types";

type DBNumber = string | number | null;
type RawReport = Omit<PerformanceReport, "initial_balance" | "net_profit" | "win_rate" | "profit_factor" | "max_drawdown_pct" | "total_trades"> & {
  initial_balance: DBNumber; net_profit: DBNumber; win_rate: DBNumber;
  profit_factor: DBNumber; max_drawdown_pct: DBNumber; total_trades: DBNumber;
};
type RawPoint = { recorded_at: string; balance: string | number; equity: string | number };
const asNumber = (value: DBNumber): number | null => value === null ? null : Number(value);
export async function fetchDataset(slug: string, kind: PerformanceKind): Promise<PerformanceDataset | null> {
  const safe = encodeURIComponent(slug);
  const reports = await dbRequest<RawReport[]>(
    `performance_reports?series_slug=eq.${safe}&kind=eq.${kind}&select=series_slug,kind,label,account_type,broker_label,currency,symbol,initial_balance,net_profit,win_rate,profit_factor,max_drawdown_pct,total_trades,period_start,period_end,updated_at&limit=1`,
  );
  if (reports.length === 0) return null;
  const raw = reports[0];
  const report: PerformanceReport = {
    ...raw,
    initial_balance: asNumber(raw.initial_balance), net_profit: asNumber(raw.net_profit),
    win_rate: asNumber(raw.win_rate), profit_factor: asNumber(raw.profit_factor),
    max_drawdown_pct: asNumber(raw.max_drawdown_pct), total_trades: asNumber(raw.total_trades),
  };
  const points = await dbRequest<RawPoint[]>(
    `performance_points?series_slug=eq.${safe}&kind=eq.${kind}&select=recorded_at,balance,equity&order=recorded_at.asc&limit=2000`,
  );
  return { report, points: points.map((p): PerformancePoint => ({ recorded_at: p.recorded_at, balance: Number(p.balance), equity: Number(p.equity) })) };
}
