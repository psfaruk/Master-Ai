import { NextResponse } from "next/server";
import {
  getCandlesForPair,
  startCandlePoller,
  refreshCandles,
} from "@/lib/candle-fetcher";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 15;

/**
 * GET /api/candles?pair=USDCOP_otc&limit=60
 *
 * Returns the candle history for one pair, newest first. Used by the
 * per-pair candle chart in the History tab.
 *
 * The candle cache is shared with the backtest poller; this endpoint just
 * reads from it. If the cache is empty (cold start), we trigger a refresh
 * and return what we have — the client can re-poll in a moment.
 */
export async function GET(request: Request) {
  startCandlePoller();

  const url = new URL(request.url);
  const pair = url.searchParams.get("pair");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 60)) : 60;

  if (!pair) {
    return NextResponse.json(
      { error: "missing_pair", message: "Pass ?pair=USDCOP_otc" },
      { status: 400 }
    );
  }

  let candles = getCandlesForPair(pair, limit);
  if (candles.length === 0) {
    // Cold cache — refresh and retry once.
    await refreshCandles().catch(() => {});
    candles = getCandlesForPair(pair, limit);
  }

  return NextResponse.json(
    {
      pair,
      candles: candles.slice(0, limit),
      count: Math.min(candles.length, limit),
      total: candles.length,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
