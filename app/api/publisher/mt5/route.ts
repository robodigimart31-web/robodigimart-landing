import { NextRequest, NextResponse } from "next/server";
import { authorized, accountHash, isFiniteNumber } from "@/lib/security";
import { databaseConfigured, dbRequest } from "@/lib/supabase-rest";

export const runtime = "nodejs";
type MT5Payload = {
  product_slug: string; account_login: string; broker: string;
  account_type: "real" | "demo";
  currency: string; symbol: string;
  balance: number; equity: number;
  initial_balance: number;
  net_profit: number; win_rate: number; profit_factor: number | null;
  total_trades: number; period_start_unix: number;
  recorded_at_unix: number;
};
function valid(p: unknown): p is MT5Payload {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  return x.product_slug === "quadriga"
    && typeof x.account_login === "string" && /^[0-9]{3,18}$/.test(x.account_login)
    && typeof x.broker === "string" && x.broker.length > 0 && x.broker.length <= 100
    && (x.account_type === "real" || x.account_type === "demo")
    && typeof x.currency === "string" && /^[A-Z]{3,6}$/.test(x.currency)
    && typeof x.symbol === "string" && /^[\w.\-]{2,30}$/.test(x.symbol)
    && isFiniteNumber(x.balance, -1e12, 1e12) && isFiniteNumber(x.equity, -1e12, 1e12)
    && isFiniteNumber(x.initial_balance, 0, 1e12)
    && isFiniteNumber(x.net_profit, -1e12, 1e12)
    && isFiniteNumber(x.win_rate, 0, 100)
    && (x.profit_factor === null || isFiniteNumber(x.profit_factor, 0, 1e8))
    && isFiniteNumber(x.total_trades, 0, 100000000) && Number.isInteger(x.total_trades)
    && isFiniteNumber(x.period_start_unix, 1577836800, 4102444800)
    && isFiniteNumber(x.recorded_at_unix, 1577836800, 4102444800);
}
export async function POST(request: NextRequest) {
  if (!authorized(request.headers.get("authorization"), process.env.PUBLISHER_API_KEY)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!databaseConfigured) return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  if (Number(request.headers.get("content-length") || 0) > 20000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!valid(input)) return NextResponse.json({ error: "Invalid or incomplete payload" }, { status: 422 });
  const p = input;
  const ts = new Date(p.recorded_at_unix * 1000);
  const now = Date.now();
  if (Math.abs(ts.getTime() - now) > 86400000 || p.period_start_unix > p.recorded_at_unix)
    return NextResponse.json({ error: "Invalid timestamps" }, { status: 422 });
  const hash = accountHash(p.account_login, p.broker);
  try {
    // One dedicated MT5 account for each product in v1. Do not silently substitute accounts.
    const existing = await dbRequest<Array<{ account_hash: string | null }>>(
      "performance_reports?series_slug=eq.quadriga&kind=eq.live&select=account_hash&limit=1",
    );
    if (existing.length && existing[0].account_hash && existing[0].account_hash !== hash)
      return NextResponse.json({ error: "Different MT5 account. Contact administrator to relink." }, { status: 409 });
    const slug = p.product_slug;
    const snapshot = { series_slug: slug, kind: "live", recorded_at: ts.toISOString(), balance: p.balance, equity: p.equity };
    // Write snapshot first. Snapshot history is durable and independently useful.
    await dbRequest("performance_points?on_conflict=series_slug,kind,recorded_at", "POST", [snapshot]);
    const points = await dbRequest<Array<{ equity: number | string }>>(
      `performance_points?series_slug=eq.${slug}&kind=eq.live&select=equity&order=recorded_at.asc&limit=2000`,
    );
    let peak = 0;
    let maxDrawdown = 0;
    for (const row of points) {
      const equity = Number(row.equity);
      peak = Math.max(peak, equity);
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    }
    await dbRequest("performance_reports?on_conflict=series_slug,kind", "POST", [{
      series_slug: slug, kind: "live", label: "MT5 Account Performance",
      account_hash: hash, account_type: p.account_type, broker_label: p.broker,
      currency: p.currency, symbol: p.symbol,
      initial_balance: p.initial_balance || null,
      net_profit: p.net_profit, win_rate: p.win_rate, profit_factor: p.profit_factor,
      max_drawdown_pct: Math.round(maxDrawdown * 100) / 100,
      total_trades: p.total_trades,
      period_start: new Date(p.period_start_unix * 1000).toISOString(),
      period_end: ts.toISOString(), updated_at: new Date().toISOString(),
    }]);
    return NextResponse.json({ ok: true, received_at: new Date().toISOString(), next_sync_hours: 12 });
  } catch {
    return NextResponse.json({ error: "Could not persist performance data" }, { status: 503 });
  }
}
