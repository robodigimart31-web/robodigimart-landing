import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/supabase-rest";
import { fetchDataset } from "@/lib/performance-db";
import type { PublicPerformanceResponse } from "@/lib/performance-types";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("product") ?? "quadriga";
  if (slug !== "quadriga") return NextResponse.json({ error: "Unknown product" }, { status: 404 });
  if (!databaseConfigured) {
    return NextResponse.json<PublicPerformanceResponse>({ configured: false, live: null, backtest: null }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const [live, backtest] = await Promise.all([fetchDataset(slug, "live"), fetchDataset(slug, "backtest")]);
    return NextResponse.json<PublicPerformanceResponse>({ configured: true, live, backtest }, { headers: { "Cache-Control": "public, s-maxage=180, stale-while-revalidate=60" } });
  } catch {
    return NextResponse.json<PublicPerformanceResponse>({ configured: true, live: null, backtest: null, error: "Data sementara tidak tersedia" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
