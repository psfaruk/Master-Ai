import { NextResponse } from "next/server";
import { aggregateSignals } from "@/lib/signal-aggregator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/aggregated
 *
 * Query params:
 *   - freshness (number, seconds, default 600): how recent a signal must be
 *     to be considered "fresh" for consensus purposes.
 *
 * Returns a unified snapshot of call/put signals from the 3 source apps
 * plus per-pair consensus (2-bot agree / 3-bot agree / conflict / single).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("freshness");
  let freshness = 1800; // 30 minutes default — accounts for App1's stale token
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 86400) freshness = n;
  }

  try {
    const result = await aggregateSignals(freshness);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "aggregation_failed", message: e?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
