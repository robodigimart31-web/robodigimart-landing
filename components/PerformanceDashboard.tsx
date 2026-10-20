"use client";
import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import type { PerformanceDataset, PerformancePoint, PublicPerformanceResponse } from "@/lib/performance-types";
import { languageTag, type Locale } from "@/lib/i18n";
import { performanceId } from "@/lib/performance-copy";
import backtestData from "@/lib/backtest-data.json";
const importedBacktest = backtestData as PerformanceDataset;
const LocaleContext = createContext<Locale>("id");
function useCopy() {
 const locale = useContext(LocaleContext);
 return {locale, t: (key: keyof typeof performanceId) => locale === "id" ? performanceId[key] : key};
}
type Range = "1M" | "3M" | "6M" | "ALL";
const ranges: Range[] = ["1M", "3M", "6M", "ALL"];
const money = (value: number | null, currency: string, locale: Locale) => {
  if (value === null) return "—";
  try { return new Intl.NumberFormat(languageTag(locale), {style: "currency", currency, maximumFractionDigits: 2}).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
};
const num = (v: number | null, locale: Locale, digits=2) => v === null ? "—" : new Intl.NumberFormat(languageTag(locale), {minimumFractionDigits:digits,maximumFractionDigits:digits}).format(v);
const dateString = (date: string, locale: Locale) => new Intl.DateTimeFormat(languageTag(locale), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(date));
function filteredPoints(points: PerformancePoint[], range: Range) {
  if (range === "ALL" || !points.length) return points;
  const latest = new Date(points[points.length - 1].recorded_at);
  const cutoff = new Date(latest);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - ({ "1M": 1, "3M": 3, "6M": 6 }[range]));
  return points.filter(p => new Date(p.recorded_at) >= cutoff);
}
function EquityChart({ points, balance = false, profit = false }: {points: PerformancePoint[];balance?:boolean;profit?:boolean}) {
 const {t} = useCopy();
 const gradId = useId();
  if (points.length < 2) return <EmptyCurve/>;
  const width = 780, height = 250, margin = 26;
  const value = (p: PerformancePoint) => profit ? p.profit! : balance ? p.balance! : p.equity!;
  const values = points.map(value);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * 0.18, Math.abs(max) * 0.01, 1);
  const lo = min - pad, hi = max + pad;
  const firstTime = Date.parse(points[0].recorded_at);
  const duration = Math.max(1, Date.parse(points[points.length-1].recorded_at) - firstTime);
  const x = (i: number) => margin + ((Date.parse(points[i].recorded_at) - firstTime) / duration) * (width - 2*margin);
  const y = (v: number) => height - margin - ((v-lo)/(hi-lo)) * (height - 2*margin);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(value(p)).toFixed(1)}`).join(" ");
  const fill = `${line} L ${x(points.length-1)} ${height-margin} L ${margin} ${height-margin} Z`;
  return <svg className="equity-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t(profit ? "Cumulative HELIX profit chart" : balance ? "Historical account balance chart" : "Historical account equity chart")}>
    <defs><linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d7a448" stopOpacity=".35"/><stop offset="100%" stopColor="#d7a448" stopOpacity="0"/></linearGradient></defs>
    {[0,1,2,3,4].map(n => <line key={n} x1={margin} x2={width-margin} y1={margin+n*(height-2*margin)/4} y2={margin+n*(height-2*margin)/4} stroke="#bfa774" strokeOpacity=".13" strokeDasharray="3 7"/>)}
    <path d={fill} fill={`url(#${gradId})`}/><path d={line} fill="none" stroke="#f8c469" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>
    <circle cx={x(points.length-1)} cy={y(value(points[points.length-1]))} r="4" fill="#ffe3a2"/>
  </svg>;
}
function EmptyCurve() {
 const {t}=useCopy();
  return <div className="empty-curve"><Icon name="chart" size={30}/><strong>{t("Awaiting performance history")}</strong><span>{t("The chart appears when performance data is available.")}</span></div>;
}
function MonthlyBars({points, currency, balance = false, monthly}: {points: PerformancePoint[];currency: string;balance?:boolean;monthly?:{month:string;change:number}[]}) {
 const {t,locale}=useCopy();
  const bars = useMemo(() => {
    if (monthly) return monthly.slice(-8);
    const map = new Map<string, {first: number; last: number}>();
    for (const p of points) {
      const amount = balance ? p.balance : p.equity;
      if (amount === null) continue;
      const key = p.recorded_at.slice(0,7);
      const v = map.get(key);
      if (v) v.last = amount; else map.set(key, {first: amount, last: amount});
    }
    const entries = [...map.entries()];
    // Compare each month end against prior month end, if present.
    return entries.slice(-8).map(([month, values], i, current) => {
      const index = entries.findIndex(e => e[0] === month);
      const prev = index > 0 ? entries[index - 1][1].last : values.first;
      return {month, change: values.last - prev};
    });
  }, [points, balance, monthly]);
  if ((!monthly && points.length < 2) || bars.length < 1) return <div className="mini-empty">{t("Monthly returns will appear here.")}</div>;
  const maximum = Math.max(...bars.map(b => Math.abs(b.change)), 1);
  return <div className="monthly-chart">{bars.map(bar => <div key={bar.month} className="month-col" title={`${bar.month}: ${money(bar.change,currency,locale)}`}><div className="month-bar-track"><div className={`month-bar ${bar.change < 0 ? "negative" : ""}`} style={{height: `${Math.max(3, Math.abs(bar.change)/maximum * 85)}%`}}/></div><span>{new Date(bar.month + "-01T00:00:00Z").toLocaleDateString(languageTag(locale),{month:"short",timeZone:"UTC"})}</span></div>)}</div>;
}
function DataCard({kind, dataset, range, setRange, loading, failed}: {kind:"live"|"backtest";dataset:PerformanceDataset|null;range:Range;setRange:(range:Range)=>void;loading:boolean;failed:boolean}) {
  const {t:baseT,locale}=useCopy();
  const isLive = kind === "live";
  if (isLive && dataset?.scope !== "helix_magic_681") dataset = null;
  const report = dataset?.report;
  const restored = report?.provenance === "owner_curated_manual_restore";
  const restoreDisclaimer = "Owner-restored history: the baseline uses owner-selected deals at exactly 1.00 lot; magic is unverified for part of the source. Net realized P/L covers all selected deals. Win rate, profit factor and completed-position count use only mapped, fully closed positions; unresolved positions are excluded and may be updated by future verified syncs." as const;
  const t = (value:Parameters<typeof baseT>[0]) => restored && value.startsWith("Only HELIX positions opened with magic") ? baseT(restoreDisclaimer) : restored && value.startsWith("REAL") && value.includes("DELAYED") ? baseT("REAL · RESTORED") : baseT(value);
  const balance = !isLive && dataset?.chart_basis === "balance";
  const sourcePoints = dataset?.points ?? [];
  const points = filteredPoints(sourcePoints.filter(p => isLive ? Number.isFinite(p.profit) : balance ? p.balance !== null : p.equity !== null), range);
  const isStale = isLive && report ? (Date.now() - new Date(report.updated_at).getTime()) > 15*3600*1000 : false;
  const currency = report?.currency || "USD";
  return <article className={`performance-card ${isLive ? "live-card" : "test-card"}`}>
    <div className="p-card-head"><div className="p-card-title"><div className="p-icon"><Icon name={isLive ? "activity" : "terminal"} size={21}/></div><div><h3>{isLive ? t("Real Account Performance") : t("Backtest Performance")}</h3><p>{isLive ? t("Reported from MT5 · Sync every 12 hours") : t("Historical Strategy Tester results")}</p></div></div>
      <span className={`status-tag ${report ? (isLive ? (report.account_type === "real" ? "status-live" : "status-demo") : "status-test") : "status-wait"}`}>
        {report ? (isLive ? (report.account_type === "real" ? t("REAL · DELAYED") : t("DEMO · DELAYED")) : t("BACKTEST")) : t("NO DATA")}
      </span>
    </div>
    <div className="perf-inner">
      <div className="sync-row"><span><Icon name="clock" size={14}/> {report ? `${t("Last updated")}: ${dateString(report.updated_at, locale)}` : (loading ? t("Loading records…") : t("Not connected yet"))}</span>{isStale ? <span className="stale">{t("Update overdue")}</span> : null}</div>
      <div className="metrics-grid">
        <div className="metric"><label>{t("Net Profit")}</label><strong>{money(report?.net_profit ?? null, currency,locale)}</strong></div>
        <div className="metric"><label>{t("Win Rate")}</label><strong>{report?.win_rate == null ? "—" : `${num(report.win_rate,locale,1)}%`}</strong></div>
        <div className="metric"><label>{t("Profit Factor")}</label><strong>{num(report?.profit_factor ?? null,locale)}</strong></div>
        <div className="metric"><label>{t(isLive ? "Closed Positions" : balance ? "Max Equity DD (relative)" : "Max Drawdown")}</label><strong>{isLive ? (report?.total_trades?.toLocaleString(languageTag(locale)) ?? "-") : report?.max_drawdown_pct == null ? "-" : `${num(report.max_drawdown_pct,locale,2)}%`}</strong></div>
      </div>
      {isLive && restored && <p className="card-disclaimer">{t("Position metrics use mapped, fully closed positions only; net profit covers the full selected history.")} {t("Unmapped deals")}: {report?.excluded_unmapped_deal_count ?? 0}; {t("Incomplete position groups")}: {report?.excluded_incomplete_position_count ?? 0}.</p>}
      <div className="chart-head"><h4>{t(isLive ? "Cumulative Net Profit" : balance ? "Balance Curve (daily close)" : "Equity Curve")}</h4><div className="chart-ranges" role="group" aria-label={`${t("Range")} ${t(isLive ? "Real Account Performance" : "Backtest Performance")}`}>{ranges.map(r=><button aria-pressed={range===r} onClick={()=>setRange(r)} className={range===r ? "selected" : ""} key={r}>{locale === "id" ? ({"1M":"1B","3M":"3B","6M":"6B","ALL":"SEMUA"}[r]) : r}</button>)}</div></div>
      {failed ? <div className="empty-curve">{t("Performance data is temporarily unavailable.")}</div> : <EquityChart points={points} balance={balance} profit={isLive}/>}
      {points.length >= 2 && <div className="chart-dates"><span>{dateString(points[0].recorded_at,locale)}</span><span>{dateString(points[points.length-1].recorded_at,locale)}</span></div>}
      <div className="p-bottom"><div><h4>{t("Monthly P/L")}</h4><MonthlyBars points={dataset?.points || []} currency={currency} balance={balance} monthly={dataset?.monthly}/></div><div className="account-facts"><h4>{t("Trading Information")}</h4><dl><dt>{t("Account")}</dt><dd>{(report?.account_type === "backtest" ? t("BACKTEST") : report?.account_type.toUpperCase()) || "—"}</dd>{!isLive && <><dt>{t("Initial Deposit")}</dt><dd>{money(report?.initial_balance ?? null,currency,locale)}</dd></>}<dt>{t("Symbol")}</dt><dd>{report?.symbol || "—"}</dd><dt>{t(isLive ? "Closed Positions" : "Total Trades")}</dt><dd>{report?.total_trades?.toLocaleString(languageTag(locale)) ?? "—"}</dd><dt>{t("Period")}</dt><dd>{report?.period_start ? `${dateString(report.period_start,locale)} - ${report.period_end ? dateString(report.period_end,locale) : ""}` : "—"}</dd></dl></div></div>
      {balance && !isLive && <p className="card-disclaimer">{t("Balance excludes floating P/L. Drawdown is MT5 relative equity drawdown; monthly figures are balance changes. Metrics cover the full test period.")} {dataset?.timeframe} / {dataset?.history_quality}</p>}
      {isLive && report && <p className="card-disclaimer">{t("Only HELIX positions opened with magic 681000-681999 are included. Net profit includes attached commission, swap and fees; excludes deposits, withdrawals, other positions and floating P/L. History uses broker time.")}</p>}
      <p className="card-disclaimer"><Icon name="info" size={14}/>{isLive ? t("Results are self-reported by the connected MT5 terminal, not independently verified.") : t("Backtests are simulations, not actual executions, and do not guarantee future performance.")}</p>
    </div>
  </article>;
}
export function PerformanceDashboard({locale = "id"}: {locale?:Locale}) {
 return <LocaleContext.Provider value={locale}><Dashboard/></LocaleContext.Provider>;
}
function Dashboard() {
 const {t}=useCopy();
  const [data, setData] = useState<PublicPerformanceResponse>({configured:false,live:null,backtest:importedBacktest});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [liveRange,setLiveRange] = useState<Range>("ALL");
  const [backtestRange,setBacktestRange] = useState<Range>("ALL");
  useEffect(()=>{
    const controller = new AbortController();
    fetch("https://helix-performance.robo-digimart31.workers.dev/api/performance", {signal:controller.signal})
      .then(async response=>{if (!response.ok) throw new Error("Unavailable");return response.json() as Promise<PublicPerformanceResponse>;})
      .then(result => setData({...result, backtest:result.backtest ?? importedBacktest})).catch(err=>{if (err.name !== "AbortError") setFailed(true);})
      .finally(()=>{if (!controller.signal.aborted) setLoading(false);});
    return ()=>controller.abort();
  },[]);
  return <section className="section performance-section" id="performance"><div className="container">
    <div className="section-header"><div><span className="eyebrow">{t("TRANSPARENCY THROUGH DATA")}</span><h2>MT5 <em>{t("Trading Performance")}</em></h2><p>{t("Two perspectives. Actual account records and historical strategy simulations.")}</p></div><span className="product-selector">HELIX QUADRIGA <Icon name="chevron" size={15}/></span></div>
    <div className="performance-grid"><DataCard kind="live" dataset={data.live} range={liveRange} setRange={setLiveRange} loading={loading} failed={failed}/><DataCard kind="backtest" dataset={data.backtest} range={backtestRange} setRange={setBacktestRange} loading={false} failed={failed && !data.backtest}/></div>
    <p className="performance-note"><Icon name="info" size={17}/>{t("Market risk is substantial. Live account statistics and backtests are different datasets and must never be treated as equivalent. Past performance does not guarantee future results.")}</p>
  </div></section>;
}
