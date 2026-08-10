import { NextResponse } from "next/server";
import { runBacktest } from "@/lib/backtest-runner";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60; // allow up to 60s for the cross-source fetch

/**
 * GET /api/backtest
 *
 * Runs a live backtest against the 3 source apps' historical signal data,
 * computes consensus accuracy, and returns the structured result.
 */
export async function GET() {
  try {
    const result = await runBacktest();
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "backtest_failed", message: e?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
