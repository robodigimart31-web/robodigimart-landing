import { NextRequest, NextResponse } from "next/server";
import { authorized, isFiniteNumber } from "@/lib/security";
import { databaseConfigured, dbRequest } from "@/lib/supabase-rest";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  if (!authorized(request.headers.get("authorization"), process.env.BACKTEST_IMPORT_KEY))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!databaseConfigured) return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  if (Number(request.headers.get("content-length") || 0) > 500000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid input" }, { status: 422 });
  const b = body as Record<string, unknown>;
  const stats = b.stats as Record<string, unknown> | undefined;
  const points = b.points;
  if (b.product_slug !== "quadriga" || !stats || typeof stats !== "object" || !Array.isArray(points) || points.length < 2 || points.length > 1000)
    return NextResponse.json({ error: "product_slug, stats, and 2–1000 points required" }, { status: 422 });
  if (!(typeof b.label === "string" && b.label.length > 0 && b.label.length <= 100)
    || !(typeof b.symbol === "string" && /^[\w.\-]{2,30}$/.test(b.symbol))
    || !(typeof b.currency === "string" && /^[A-Z]{3,6}$/.test(b.currency))
    || !isFiniteNumber(stats.initial_balance, 0, 1e12)
    || !isFiniteNumber(stats.net_profit, -1e12, 1e12)
    || !isFiniteNumber(stats.win_rate, 0, 100)
    || !(stats.profit_factor === null || isFiniteNumber(stats.profit_factor, 0, 1e8))
    || !isFiniteNumber(stats.max_drawdown_pct, 0, 100)
    || !isFiniteNumber(stats.total_trades, 0, 100000000))
    return NextResponse.json({ error: "Invalid stats fields" }, { status: 422 });
  const converted: Array<{series_slug: string; kind: string; recorded_at: string; balance: number; equity: number}> = [];
  for (const point of points) {
    if (!point || typeof point !== "object") return NextResponse.json({ error: "Invalid point" }, { status: 422 });
    const p = point as Record<string, unknown>;
    if (typeof p.date !== "string" || !Number.isFinite(Date.parse(p.date)) || !isFiniteNumber(p.balance, -1e12, 1e12) || !isFiniteNumber(p.equity, -1e12, 1e12))
      return NextResponse.json({ error: "Invalid point: date/balance/equity" }, { status: 422 });
    converted.push({ series_slug: "quadriga", kind: "backtest", recorded_at: new Date(p.date).toISOString(), balance: p.balance, equity: p.equity });
  }
  converted.sort((a,b) => a.recorded_at.localeCompare(b.recorded_at));
  // Prevent a re-import from mixing an old curve with a different new curve.
  // Supabase RPC defined in migration performs a transactional replace.
  try {
    const rpc = {
      p_report: {
        series_slug: "quadriga", kind: "backtest", label: b.label, account_type: "backtest",
        broker_label: null, currency: b.currency, symbol: b.symbol,
        initial_balance: stats.initial_balance, net_profit: stats.net_profit,
        win_rate: stats.win_rate, profit_factor: stats.profit_factor,
        max_drawdown_pct: stats.max_drawdown_pct, total_trades: Math.trunc(stats.total_trades as number),
        period_start: converted[0].recorded_at, period_end: converted[converted.length-1].recorded_at,
        updated_at: new Date().toISOString(),
      },
      p_points: converted,
    };
    await dbRequest("rpc/import_backtest_report", "POST", rpc);
    return NextResponse.json({ ok: true, imported_points: converted.length });
  } catch {
    return NextResponse.json({ error: "Backtest import failed" }, { status: 503 });
  }
}
