import { NextResponse } from "next/server";
import { aggregateWithRaw, type AppId, type SourceSignal } from "@/lib/signal-aggregator";
import { getApp2CacheStats, pollApp2Now, startApp2CachePoller } from "@/lib/app2-cache";
import { candleFloor, getCandleOffsetSec, CANDLE_SEC } from "@/lib/signal-normalize";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const APPS: AppId[] = ["app1", "app2", "app3"];

/**
 * GET /api/diag
 *
 * Alignment diagnostics. Answers, with numbers instead of guesswork:
 *
 *   - Is each app returning rows at all, and how many are dropped (and why)?
 *   - Do the three apps agree on pair names after canonicalization?
 *   - Do they put their signals in the SAME candle bucket? `offsets` reports,
 *     for each app pair, the distribution of candle differences measured on
 *     pairs where both apps have a recent signal. A modal offset of 0 means
 *     they are aligned; a consistent ±1 means one app labels the candle it
 *     analysed while the other labels the candle it predicts — fix that by
 *     setting e.g. APP2_CANDLE_OFFSET=1 (see signal-normalize.ts).
 *
 * This endpoint is the thing to look at first when an app's column on the
 * dashboard is empty.
 */
export async function GET(request: Request) {
  startApp2CachePoller();

  const url = new URL(request.url);
  if (url.searchParams.get("poll") === "1") {
    // Force one App 2 cache poll so a cold process has something to report.
    await pollApp2Now();
  }

  const { nowSec, perApp } = await aggregateWithRaw(1800);
  const currentCandle = candleFloor(nowSec);

  // ---- Per-app summary ----
  const apps = APPS.map((id) => {
    const r = perApp[id];
    const sigs = r.signals;
    const candleTimes = sigs.map((s) => s.candleTime).filter((c) => c > 0);
    const recent = sigs.filter((s) => s.candleTime >= currentCandle - 5 * CANDLE_SEC);
    return {
      app: id,
      health: r.health,
      error: r.error ?? null,
      detail: r.detail ?? null,
      rawRows: r.rawCount,
      normalizedSignals: sigs.length,
      skipped: r.skipped,
      candleOffsetApplied: getCandleOffsetSec(id) / CANDLE_SEC,
      distinctPairs: Array.from(new Set(sigs.map((s) => s.pair))).sort(),
      newestCandle: candleTimes.length ? Math.max(...candleTimes) : null,
      oldestCandle: candleTimes.length ? Math.min(...candleTimes) : null,
      /** How far the newest candle is from the current minute, in candles. */
      newestCandleLagCandles: candleTimes.length
        ? (currentCandle - Math.max(...candleTimes)) / CANDLE_SEC
        : null,
      signalsInLast5Candles: recent.length,
      validForOwnCandle: sigs.filter((s) => s.validForCandle).length,
      invalidForOwnCandle: sigs.filter((s) => !s.validForCandle).length,
      sample: sigs
        .slice()
        .sort((a, b) => b.candleTime - a.candleTime)
        .slice(0, 5)
        .map(sampleOf),
    };
  });

  // ---- Pair-name overlap ----
  const pairSets: Record<AppId, Set<string>> = {
    app1: new Set(perApp.app1.signals.map((s) => s.pair)),
    app2: new Set(perApp.app2.signals.map((s) => s.pair)),
    app3: new Set(perApp.app3.signals.map((s) => s.pair)),
  };
  const pairOverlap = pairCombos().map(([a, b]) => ({
    apps: `${a}↔${b}`,
    shared: [...pairSets[a]].filter((p) => pairSets[b].has(p)).sort(),
    onlyIn: {
      [a]: [...pairSets[a]].filter((p) => !pairSets[b].has(p)).sort(),
      [b]: [...pairSets[b]].filter((p) => !pairSets[a].has(p)).sort(),
    },
  }));

  // ---- Candle offset between apps ----
  // For every pair both apps cover, compare their newest candle. If the apps
  // are aligned this is 0 for (almost) every pair.
  const offsets = pairCombos().map(([a, b]) => {
    const newestByPair = (id: AppId) => {
      const m = new Map<string, number>();
      for (const s of perApp[id].signals) {
        const cur = m.get(s.pair);
        if (cur === undefined || s.candleTime > cur) m.set(s.pair, s.candleTime);
      }
      return m;
    };
    const ma = newestByPair(a);
    const mb = newestByPair(b);
    const diffs: Record<string, number> = {};
    let samples = 0;
    for (const [pair, ca] of ma) {
      const cb = mb.get(pair);
      if (cb === undefined) continue;
      const d = (ca - cb) / CANDLE_SEC;
      // Only meaningful for nearby candles; far-apart values just mean one app
      // has deeper history than the other.
      if (Math.abs(d) > 10) continue;
      diffs[String(d)] = (diffs[String(d)] ?? 0) + 1;
      samples++;
    }
    let modal: number | null = null;
    let modalCount = 0;
    for (const [d, n] of Object.entries(diffs)) {
      if (n > modalCount) { modalCount = n; modal = Number(d); }
    }
    return {
      apps: `${a}-${b}`,
      samples,
      /** Candle difference histogram: key = candles(a) − candles(b). */
      histogram: diffs,
      modalOffsetCandles: modal,
      confidence: samples > 0 ? Number((modalCount / samples).toFixed(2)) : 0,
      hint:
        modal === null
          ? "no shared pairs with comparable candles"
          : modal === 0
          ? "aligned — no offset needed"
          : `${a} runs ${modal} candle(s) ahead of ${b}; consider ${b.toUpperCase()}_CANDLE_OFFSET=${modal} or ${a.toUpperCase()}_CANDLE_OFFSET=${-modal}`,
    };
  });

  // ---- How many candles actually have 2 or 3 apps in them? ----
  const bucket = new Map<string, Set<AppId>>();
  for (const id of APPS) {
    for (const s of perApp[id].signals) {
      if (!s.validForCandle) continue;
      if (s.candleTime < currentCandle - 30 * CANDLE_SEC) continue;
      const key = `${s.pair}|${s.candleTime}`;
      let set = bucket.get(key);
      if (!set) { set = new Set(); bucket.set(key, set); }
      set.add(id);
    }
  }
  const coverage = { oneApp: 0, twoApps: 0, threeApps: 0 };
  const appPresence: Record<AppId, number> = { app1: 0, app2: 0, app3: 0 };
  bucket.forEach((set) => {
    if (set.size === 1) coverage.oneApp++;
    else if (set.size === 2) coverage.twoApps++;
    else if (set.size >= 3) coverage.threeApps++;
    set.forEach((id) => { appPresence[id]++; });
  });

  return NextResponse.json(
    {
      now: { unixSec: nowSec, currentCandle, iso: new Date(nowSec * 1000).toISOString() },
      apps,
      app2Cache: getApp2CacheStats(),
      pairOverlap,
      offsets,
      candleCoverageLast30Candles: { ...coverage, buckets: bucket.size, appPresence },
      notes: [
        "offsets.modalOffsetCandles should be 0 for every app pair. A stable non-zero value means the apps label candles differently — set APP{N}_CANDLE_OFFSET to correct it.",
        "pairOverlap.onlyIn shows pair names one app has and the other doesn't — after canonicalization these should only be genuinely different assets.",
        "app2Cache.entries growing over time confirms the App 2 history poller is recording candles.",
      ],
    },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }
  );
}

function pairCombos(): Array<[AppId, AppId]> {
  return [
    ["app1", "app2"],
    ["app1", "app3"],
    ["app2", "app3"],
  ];
}

function sampleOf(s: SourceSignal) {
  return {
    pair: s.pair,
    direction: s.direction,
    candleTime: s.candleTime,
    candleUtc: new Date(s.candleTime * 1000).toISOString().slice(11, 16),
    emittedAt: s.timestamp,
    emittedUtc: s.timestamp > 0 ? new Date(s.timestamp * 1000).toISOString().slice(11, 19) : null,
    leadSec: s.candleTime - s.timestamp,
    validForCandle: s.validForCandle,
    fresh: s.fresh,
    cached: s.cached ?? false,
  };
}
