export type PerformanceKind = "live" | "backtest";
export interface PerformanceReport {
  series_slug: string;
  kind: PerformanceKind;
  label: string;
  account_type: "real" | "demo" | "backtest";
  broker_label: string | null;
  currency: string;
  symbol: string;
  initial_balance: number | null;
  net_profit: number | null;
  win_rate: number | null;
  profit_factor: number | null;
  max_drawdown_pct: number | null;
  total_trades: number | null;
  period_start: string | null;
  period_end: string | null;
  updated_at: string;
}
export interface PerformancePoint {
  recorded_at: string;
  balance: number;
  equity: number | null;
}
export interface PerformanceDataset {
  balance_points?: PerformancePoint[];
  monthly?: {month:string;change:number}[];
  cashflow?: number;
  chart_basis?: string;
  timeframe?: string;
  history_quality?: string;
  report: PerformanceReport;
  points: PerformancePoint[];
}
export interface PublicPerformanceResponse {
  configured: boolean;
  live: PerformanceDataset | null;
  backtest: PerformanceDataset | null;
  error?: string;
}
