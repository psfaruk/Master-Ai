import { NextResponse } from "next/server";
import { getSnapshot, refreshSnapshot, startPoller } from "@/lib/snapshot-poller";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

/**
 * GET /api/snapshot
 * GET /api/snapshot?refresh=1  — force a fresh poll before returning
 *
 * Returns the latest cached aggregated snapshot. The background poller
 * (started on first request) refreshes the cache every 5s, so this is
 * a cheap read even when many clients poll frequently.
 */
export async function GET(request: Request) {
  // Ensure the poller is running.
  startPoller();

  const url = new URL(request.url);
  if (url.searchParams.get("refresh") === "1") {
    await refreshSnapshot();
  }

  const { snapshot, ageMs } = getSnapshot();
  if (!snapshot) {
    return NextResponse.json(
      { error: "no_snapshot_yet", message: "First poll still running, retry in a moment." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { ...snapshot, ageMs },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
