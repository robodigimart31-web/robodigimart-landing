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
  provenance?: string;
  selection_filter?: string;
  restore_batch_id?: string;
  restored_deal_count?: number;
  magic_unverified_deal_count?: number;
  excluded_unmapped_deal_count?: number;
  excluded_incomplete_position_count?: number;
  trade_metrics_scope?: string;
  trade_metrics_complete?: boolean;
}
export interface PerformancePoint {
  recorded_at: string;
  balance: number | null;
  profit?: number;
  equity: number | null;
}
export interface PerformanceDataset {
  scope?: string;
  balance_points?: PerformancePoint[];
  monthly?: {month:string;change:number}[];
  cashflow?: number;
  chart_basis?: string;
  timeframe?: string;
  history_quality?: string;
  details?: Record<string, string>;
  tester_log?: {
    expert_file: string;
    final_balance: number;
    currency: string;
    ticks: number;
    bars: number;
    real_ticks_missing_minutes: number;
    minute_bars_with_missing_tick_detail: number | null;
    real_ticks_missing_days: number;
  };
  report: PerformanceReport;
  points: PerformancePoint[];
}
export interface PublicPerformanceResponse {
  configured: boolean;
  live: PerformanceDataset | null;
  backtest: PerformanceDataset | null;
  error?: string;
}
