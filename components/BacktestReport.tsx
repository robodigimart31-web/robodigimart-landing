import data from "@/lib/backtest-data.json";
import { choose, languageTag, type Locale } from "@/lib/i18n";

// One shared imported report keeps the homepage and product page in sync.
export function BacktestReport({locale}:{locale:Locale}) {
  const t=(id:string,en:string)=>choose(locale,id,en);
  const {report,points}=data;
  const details:Record<string,string>|undefined=data.details;
  const testerLog=data.tester_log;
  const diagnostics=(data as typeof data & {diagnostics?:Record<string,{src:string;width:number;height:number;crop?:{x:number;y:number;width:number;height:number}}>}).diagnostics;
  const charts=[
    {key:"summary",title:t("Ringkasan lengkap backtest","Full backtest summary"),description:t("Statistik asli MT5 Strategy Tester: kualitas data, profit, risiko, dan hasil transaksi.","Original MT5 Strategy Tester statistics: data quality, profit, risk and trade outcomes.")},
    {key:"distribution",title:t("Distribusi transaksi & hasil trading","Trade distribution & trading results"),description:t("Jumlah entry serta profit dan loss berdasarkan jam, hari, dan bulan.","Entries, profits and losses by hour, weekday and month.")},
    {key:"correlation",title:t("Korelasi profit, MFE & MAE","Profit, MFE & MAE correlations"),description:t("Sebaran hasil transaksi terhadap pergerakan harga yang menguntungkan (MFE) dan merugikan (MAE) selama posisi terbuka.","Trade outcomes against favorable (MFE) and adverse (MAE) price excursions while positions were open.")},
    {key:"holding",title:t("Durasi posisi","Position holding time"),description:t("Hubungan antara lama posisi terbuka dan hasil transaksi.","Trade outcomes relative to the length of time positions remained open.")},
  ];
  const number=(v:number|null,digits=2)=>v===null?"—":new Intl.NumberFormat(languageTag(locale),{maximumFractionDigits:digits}).format(v);
  const money=(v:number|null)=>v===null?"—":new Intl.NumberFormat(languageTag(locale),{style:"currency",currency:report.currency,maximumFractionDigits:2}).format(v);
  const date=(v:string)=>new Intl.DateTimeFormat(languageTag(locale),{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(v));
  const values=points.map(p=>p.balance),low=Math.min(...values),high=Math.max(...values),span=Math.max(high-low,1);
  const first=Date.parse(points[0].recorded_at),duration=Math.max(1,Date.parse(points.at(-1)!.recorded_at)-first);
  const line=points.map((p,i)=>`${i?"L":"M"}${(48+(Date.parse(p.recorded_at)-first)/duration*900).toFixed(1)},${(246-(p.balance-low)/span*200).toFixed(1)}`).join(" ");
  const detailGroups:{title:string;keys:[string,string][]}[]=[
    {title:t("Kinerja & risiko","Performance & risk"),keys:[['Gross Profit',t("Profit kotor","Gross profit")],['Gross Loss',t("Rugi kotor","Gross loss")],['Expected Payoff',t("Ekspektasi per transaksi","Expected payoff")],['Profit Factor',t("Profit factor","Profit factor")],['Recovery Factor',t("Recovery factor","Recovery factor")],['Sharpe Ratio',t("Sharpe ratio","Sharpe ratio")],['Margin Level',t("Margin level","Margin level")],['Z-Score',t("Z-Score","Z-Score")],['AHPR','AHPR'],['GHPR','GHPR'],['LR Correlation',t("Korelasi LR","LR correlation")],['LR Standard Error',t("Standard error LR","LR standard error")],['OnTester result',t("Hasil OnTester","OnTester result")]]},
    {title:t("Drawdown","Drawdown"),keys:[['Balance Drawdown Absolute',t("Drawdown saldo absolut","Absolute balance drawdown")],['Balance Drawdown Maximal',t("Drawdown saldo maksimum","Maximal balance drawdown")],['Balance Drawdown Relative',t("Drawdown saldo relatif","Relative balance drawdown")],['Equity Drawdown Absolute',t("Drawdown ekuitas absolut","Absolute equity drawdown")],['Equity Drawdown Maximal',t("Drawdown ekuitas maksimum","Maximal equity drawdown")],['Equity Drawdown Relative',t("Drawdown ekuitas relatif","Relative equity drawdown")]]},
    {title:t("Rincian transaksi","Trade details"),keys:[['Total Deals',t("Total deal","Total deals")],['Profit Trades (% of total)',t("Transaksi profit","Profit trades")],['Loss Trades (% of total)',t("Transaksi rugi","Loss trades")],['Short Trades (won %)',t("Transaksi short (menang %)","Short trades (won %)")],['Long Trades (won %)',t("Transaksi long (menang %)","Long trades (won %)")],['Largest profit trade',t("Profit terbesar","Largest profit trade")],['Largest loss trade',t("Rugi terbesar","Largest loss trade")],['Average profit trade',t("Rata-rata profit","Average profit trade")],['Average loss trade',t("Rata-rata rugi","Average loss trade")],['Maximum consecutive wins ($)',t("Kemenangan beruntun maksimum","Maximum consecutive wins")],['Maximum consecutive losses ($)',t("Kekalahan beruntun maksimum","Maximum consecutive losses")],['Maximal consecutive profit (count)',t("Profit beruntun tertinggi","Maximal consecutive profit")],['Maximal consecutive loss (count)',t("Rugi beruntun terbesar","Maximal consecutive loss")],['Average consecutive wins',t("Rata-rata kemenangan beruntun","Average consecutive wins")],['Average consecutive losses',t("Rata-rata kekalahan beruntun","Average consecutive losses")]]},
    {title:t("Data pengujian","Test data"),keys:[['Bars',t("Bar","Bars")],['Ticks',t("Tick","Ticks")],['Symbols',t("Simbol","Symbols")],['Leverage',t("Leverage","Leverage")],['Expert',t("Expert Advisor","Expert Advisor")]]}
  ];
  const stats=[
    [t("Laba bersih","Net profit"),money(report.net_profit)],
    [t("Tingkat kemenangan","Win rate"),`${number(report.win_rate)}%`],
    [t("Faktor profit","Profit factor"),number(report.profit_factor)],
    [t("Drawdown ekuitas relatif maks.","Max relative equity drawdown"),`${number(report.max_drawdown_pct)}%`],
  ];
  return <section className="product-backtest" id="backtest" aria-labelledby="backtest-heading">
    <div className="bt-heading"><div><span className="eyebrow">{t("LAPORAN STRATEGY TESTER","STRATEGY TESTER REPORT")}</span><h2 id="backtest-heading">{t("Hasil uji historis","Backtest results")} <em>QUADRIGA</em></h2><p>{date(report.period_start)} — {date(report.period_end)} · {report.symbol} / {data.timeframe}</p></div><span className="bt-badge">{t("SIMULASI HISTORIS","HISTORICAL SIMULATION")}</span></div>
    <dl className="bt-metrics">{stats.map(([label,value],i)=><div key={label} className={i===0?"bt-profit":""}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="bt-chart-layout"><div className="bt-chart"><div className="bt-chart-title"><h3>{t("Pertumbuhan saldo","Balance growth")}</h3><span>{t("Saldo akhir hari","Daily closing balance")} · {report.currency}</span></div>
      <svg viewBox="0 0 1000 280" role="img" aria-label={t("Kurva saldo hasil backtest HELIX QUADRIGA","HELIX QUADRIGA backtest balance curve")}>
        <defs><linearGradient id="bt-report-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#e9b956" stopOpacity=".25"/><stop offset="1" stopColor="#e9b956" stopOpacity="0"/></linearGradient></defs>
        {[46,96,146,196,246].map(y=><line key={y} x1="48" x2="948" y1={y} y2={y} stroke="#d7b572" strokeOpacity=".12" strokeDasharray="3 7"/>)}
        <path d={`${line} L948,260 L48,260 Z`} fill="url(#bt-report-fill)"/><path d={line} fill="none" stroke="#f3c76f" strokeWidth="3" strokeLinejoin="round"/>
      </svg><div className="bt-chart-dates"><span>{date(points[0].recorded_at)}<strong>{money(points[0].balance)}</strong></span><span>{date(points.at(-1)!.recorded_at)}<strong>{money(points.at(-1)!.balance)}</strong></span></div>
    </div><aside className="bt-context"><h3>{t("Detail pengujian","Test details")}</h3><dl>{[
      [t("Modal awal","Initial deposit"),money(report.initial_balance)],
      [t("Saldo akhir","Final balance"),money(points.at(-1)!.balance)],
      [t("Total transaksi","Total trades"),number(report.total_trades,0)],
      [t("Kualitas data","History quality"),locale === "id" ? data.history_quality.replace("real ticks","tick riil") : data.history_quality],
      [t("Broker pengujian","Test broker"),report.broker_label],
    ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></aside></div>
    {details&&<div className="bt-detail-grid">{detailGroups.map(group=><section key={group.title} className="bt-detail-card"><h3>{group.title}</h3><dl>{group.keys.filter(([key])=>details[key]).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{details[key]}</dd></div>)}</dl></section>)}</div>}
    <div className="bt-diagnostics">{charts.map((chart,index)=>{
      const asset=diagnostics?.[chart.key];
      if(!asset)return null;
      return <figure key={chart.key} className="bt-diagnostic"><figcaption><span className="bt-chart-index">0{index+1}</span><div><h3>{chart.title}</h3><p>{chart.description}</p></div></figcaption>{chart.key === "distribution" && <div className="bt-panel-key"><span>{t("Jam trading","Trading hours")}</span><span>{t("Hari dalam minggu","Weekdays")}</span><span>{t("Bulan","Months")}</span></div>}<div className="bt-original-chart" role="region" aria-label={chart.title} tabIndex={0}>{asset.crop ? <div className="bt-cropped-chart" style={{aspectRatio:`${asset.crop.width} / ${asset.crop.height}`}}><img src={asset.src} width={asset.width} height={asset.height} alt={chart.description} loading="lazy" decoding="async" style={{width:`${asset.width/asset.crop.width*100}%`,left:`${-asset.crop.x/asset.crop.width*100}%`,top:`${-asset.crop.y/asset.crop.height*100}%`}}/></div> : <img src={asset.src} width={asset.width} height={asset.height} alt={chart.description} loading="lazy" decoding="async"/>}</div><p className="bt-scroll-hint">{t("Geser ke samping untuk melihat seluruh grafik.","Scroll horizontally to view the complete chart.")}</p></figure>;
    })}</div>
    {testerLog&&testerLog.real_ticks_missing_minutes>0&&<p className="bt-data-quality-note">{t(`Catatan kualitas data: laporan MT5 menyebut ${data.history_quality}. Log tester mencatat tick riil tidak tersedia selama ${number(testerLog.real_ticks_missing_minutes,0)} menit dari ${number(testerLog.minute_bars_with_missing_tick_detail,0)} bar menit; tick hasil generasi digunakan untuk interval tersebut. Tercatat juga ${number(testerLog.real_ticks_missing_days,0)} hari penuh tanpa tick riil.`, `Data quality note: the MT5 report states ${data.history_quality}. The tester log records missing real ticks for ${number(testerLog.real_ticks_missing_minutes,0)} minutes out of ${number(testerLog.minute_bars_with_missing_tick_detail,0)} minute bars; generated ticks were used for those intervals. It also records ${number(testerLog.real_ticks_missing_days,0)} full day without real ticks.`)}</p>}
    <p className="bt-note">{t("Sumber: laporan MT5 Strategy Tester yang diimpor. Grafik menunjukkan saldo, bukan floating equity. Drawdown memakai angka penurunan ekuitas relatif maksimum dari laporan MT5. Hasil simulasi bukan hasil akun real dan tidak menjamin performa masa depan.","Source: imported MT5 Strategy Tester report. The chart shows balance, not floating equity. Drawdown is the maximum relative equity drawdown reported by MT5. Simulated results are not live account results and do not guarantee future performance.")}</p>
  </section>;
}
