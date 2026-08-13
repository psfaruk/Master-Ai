/**
 * Integration tests for the aggregator, with the 3 source apps faked.
 *
 * These reproduce the reported failure — "App 2's signals never show up" —
 * using payloads shaped the way the real apps differ from each other:
 * different pair spellings, different timestamp units, and a wall-clock string
 * rendered in a non-UTC timezone.
 *
 * As of the recent App 2 update, App 2's `time` field is the candle being
 * PREDICTED (same semantics as App 1's entryTime and App 3's time). The old
 * +1-candle shift in normalizeApp2Row() has been removed — keeping it pushed
 * App 2 one candle into the future and broke cross-app consensus entirely.
 *
 * Run with:  bun test tests/
 */

import { beforeEach, describe, expect, test } from "bun:test";

const APP1 = "https://minimum-pair-production.up.railway.app";
const APP2 = "https://binary-signals-app-production.up.railway.app";
const APP3 = "https://otc-live-trading-production.up.railway.app";

const nowSec = Math.floor(Date.now() / 1000);
const currentCandle = Math.floor(nowSec / 60) * 60;
const prevCandle = currentCandle - 60;

/** "HH:MM" for a candle, rendered as if the app used UTC+`offsetHours`. */
function clockAt(candle: number, offsetHours: number): string {
  const d = new Date((candle + offsetHours * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Route table for the fake upstreams; each test overwrites what it needs. */
let routes: Record<string, unknown> = {};

/** A route value of `{ __status: n }` makes the fake upstream answer with that
 *  HTTP status and no usable body. */
function installFetchMock() {
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body: any = key ? routes[key] : null;
    if (body && typeof body === "object" && "__status" in body) {
      return new Response("upstream error", { status: body.__status });
    }
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function baseRoutes() {
  return {
    [`${APP1}/api/health`]: { status: { live: true, tokenExpired: false } },
    [`${APP2}/api/status`]: { connected: true, streams: { active: [1, 2, 3] } },
    [`${APP3}/api/token-status`]: { connected: true, has_env_token: true, token_source: "env" },
    [`${APP1}/api/signals`]: { signals: [] },
    [`${APP2}/api/share-signals`]: { timestamp: nowSec * 1000, rows: [] },
    [`${APP3}/api/signals`]: { signals: [] },
    [`${APP3}/api/share-signals`]: { signals: [] },
  } as Record<string, unknown>;
}

/**
 * One signal per app for the same pair and the same candle — but each app
 * spells the pair its own way, uses its own timestamp unit, and App 2 renders
 * its clock in UTC+6.
 *
 * NOTE: App 2's `time` field is now the candle being PREDICTED (same semantics
 * as App 1's entryTime and App 3's time). The previous test suite assumed the
 * old behavior where `time` was the last CLOSED candle and the signal was for
 * the next one — that has been fixed in App 2 itself.
 */
function threeAppsAgreeing(direction: "CALL" | "PUT" = "CALL") {
  const r = baseRoutes();
  r[`${APP1}/api/signals`] = {
    signals: [
      {
        symbol: "USDCOP_otc",
        direction,
        // App 1 speaks milliseconds.
        signalAt: (currentCandle - 8) * 1000,
        entryTime: currentCandle * 1000,
        confidence: 0.82,
        quality: 0.75,
      },
    ],
  };
  r[`${APP2}/api/share-signals`] = {
    timestamp: nowSec, // App 2 sends time.time() — unix SECONDS, float
    rows: [
      {
        // Display-style spelling with a slash and a spaced OTC marker.
        pair: "USD/COP OTC",
        signal: direction,
        type: "OTC",
        // App 2's `time` is the candle being PREDICTED — same as App 1 and App 3.
        // No +1 shift is applied by the aggregator anymore.
        time: clockAt(currentCandle, 0),
        confidence: 78, // 0-100 scale
        strength: "strong",
        last_update: 3, // SECONDS AGO, not a timestamp
        live: true,
        buyer_pct: 63,
        seller_pct: 37,
      },
    ],
  };
  r[`${APP3}/api/share-signals`] = {
    signals: [
      {
        asset: "usdcop-otc", // lower case, dash separator
        signal: direction.toLowerCase(),
        time: currentCandle * 1000, // milliseconds
        confidence: 0.71,
        strength: "MEDIUM",
      },
    ],
  };
  return r;
}

async function aggregate(freshness = 1800) {
  const { aggregateSignals } = await import("../src/lib/signal-aggregator");
  return aggregateSignals(freshness);
}

/** Look a pair up by canonical key — never by index; pairs are sorted by
 *  consensus level, so pairs[0] is not a stable handle. */
function findPair(res: { pairs: Array<{ pair: string }> }, key: string) {
  const p = res.pairs.find((x) => x.pair === key);
  if (!p) throw new Error(`pair ${key} not in [${res.pairs.map((x) => x.pair).join(", ")}]`);
  return p as any;
}

beforeEach(async () => {
  routes = baseRoutes();
  installFetchMock();
  // The App 2 history cache is a process-wide singleton that deliberately
  // survives requests; clear it so one test's candles can't answer for another.
  const { resetApp2CacheForTests } = await import("../src/lib/app2-cache");
  resetApp2CacheForTests();
});

describe("cross-app alignment", () => {
  test("all 3 apps land on ONE pair key and ONE candle → 3-agree", async () => {
    routes = threeAppsAgreeing("CALL");
    const res = await aggregate();

    expect(res.pairs.length).toBe(1);
    const p = findPair(res, "USDCOP_otc");
    // Three different spellings collapsed into the canonical key.
    expect(p.pair).toBe("USDCOP_otc");
    expect(p.displayPair).toBe("USD/COP OTC");

    expect(p.latestCandle).not.toBeNull();
    expect(p.latestCandle!.candleTime).toBe(currentCandle);
    expect(p.consensus.level).toBe("3-agree");
    expect(p.consensus.direction).toBe("CALL");
    expect(p.consensus.agreeingApps.sort()).toEqual(["app1", "app2", "app3"]);
    expect(p.consensus.missingApps).toEqual([]);
  });

  test("App 2 is present in the candle's signal list", async () => {
    // The reported symptom: App 2's column on the dashboard was always empty.
    routes = threeAppsAgreeing("PUT");
    const res = await aggregate();

    const p = findPair(res, "USDCOP_otc");
    const sources = p.latestCandle!.signals.map((s: any) => s.source).sort();
    expect(sources).toEqual(["app1", "app2", "app3"]);

    const app2 = p.latestCandle!.signals.find((s: any) => s.source === "app2")!;
    expect(app2.direction).toBe("PUT");
    expect(app2.candleTime).toBe(currentCandle);
    expect(app2.confidence).toBeCloseTo(0.78, 5); // 0-100 → 0-1
    expect(app2.validForCandle).toBe(true);
    expect(app2.strategy).toBe("buyers=63% sellers=37%");
  });

  test("App 2 in a different timezone still aligns", async () => {
    for (const tz of [-8, -3, 0, 5, 9]) {
      routes = threeAppsAgreeing("CALL");
      (routes[`${APP2}/api/share-signals`] as any).rows[0].time = clockAt(currentCandle, tz);
      const res = await aggregate();
      const app2 = findPair(res, "USDCOP_otc").latestCandle!.signals.find(
        (s: any) => s.source === "app2"
      );
      expect(app2).toBeDefined();
      expect(app2!.candleTime).toBe(currentCandle);
    }
  });

  // --- Regressions verified against App 2's own source (psfaruk/binary-signals-app,
  // server.py /api/share-signals + feed.py). These two are why App 2's column
  // on the dashboard was empty on every row.

  test("App 2's `last_update` is an age in seconds, not a timestamp", async () => {
    routes = threeAppsAgreeing("CALL");
    // server.py: last_update = round(now - last_tick, 0)  → "3" means 3s ago.
    // Read as a unix timestamp that is 1970, making the signal look ~56 years
    // stale, and it was dropped as not fresh.
    (routes[`${APP2}/api/share-signals`] as any).rows[0].last_update = 3;

    const res = await aggregate();
    const app2 = findPair(res, "USDCOP_otc").latestCandle!.signals.find(
      (s: any) => s.source === "app2"
    );

    expect(app2).toBeDefined();
    expect(app2!.validForCandle).toBe(true);
    expect(app2!.fresh).toBe(true);
    expect(app2!.ageSec).toBeLessThan(120);
    expect(app2!.timestamp).toBe(currentCandle);
  });

  test("App 2's `time` is the candle being predicted (no shift)", async () => {
    routes = threeAppsAgreeing("CALL");
    // As of the user's App 2 update, `time` labels the candle being predicted,
    // same as App 1's entryTime and App 3's time. The aggregator no longer
    // applies a +1 shift — if it did, App 2 would land one candle ahead of
    // App 1 / App 3 and never form a consensus.
    const row = (routes[`${APP2}/api/share-signals`] as any).rows[0];
    row.time = clockAt(currentCandle, 0);

    const res = await aggregate();
    const app2 = findPair(res, "USDCOP_otc").latestCandle!.signals.find(
      (s: any) => s.source === "app2"
    )!;

    // Lands on the same candle as App 1 and App 3 — no shift.
    expect(app2.candleTime).toBe(currentCandle);
  });

  test("App 2 rows for a dead pair (time '—') are skipped, not guessed", async () => {
    routes = threeAppsAgreeing("CALL");
    (routes[`${APP2}/api/share-signals`] as any).rows.push({
      pair: "AUDCAD_otc",
      type: "OTC",
      time: "—", // server.py emits this when the pair has no stream
      signal: "CALL",
      confidence: 0,
      strength: "—",
      last_update: null,
      live: false,
    });

    const res = await aggregate();
    // No candle can be known for that row, so it must not invent one.
    expect(res.pairs.find((p) => p.pair === "AUDCAD_otc")).toBeUndefined();
  });

  test("a millisecond ctime from App 3 does not hijack the newest candle", async () => {
    routes = threeAppsAgreeing("CALL");
    // App 3's resolved-history endpoint, with ctime in milliseconds. Read as
    // seconds this used to produce a candle ~53,000 years out, which became
    // the pair's "latest candle" and blanked every other app's column.
    routes[`${APP3}/api/signals`] = {
      signals: [
        {
          asset: "USDCOP_otc",
          signal: "PUT",
          ctime: prevCandle * 1000,
          confidence: 0.6,
          result: "correct",
        },
      ],
    };
    const res = await aggregate();
    const p = findPair(res, "USDCOP_otc");

    expect(p.latestCandle!.candleTime).toBe(currentCandle);
    expect(p.consensus.level).toBe("3-agree");
    // The historical candle is still recorded, one bucket back.
    const older = p.candles.find((c: any) => c.candleTime === prevCandle);
    expect(older).toBeDefined();
    expect(older!.signals[0].outcome).toBe("CORRECT");
  });

  test("disagreement is reported as a conflict, not a false agreement", async () => {
    routes = threeAppsAgreeing("CALL");
    (routes[`${APP2}/api/share-signals`] as any).rows[0].signal = "PUT";
    const res = await aggregate();

    const p = findPair(res, "USDCOP_otc");
    expect(p.consensus.level).toBe("conflict");
    expect(p.consensus.disagreeingApps).toContain("app2");
  });

  test("signals for different candles never form a consensus", async () => {
    routes = threeAppsAgreeing("CALL");
    // Push App 1 one candle ahead: it is predicting a different minute, so it
    // must not be counted alongside App 2 / App 3.
    (routes[`${APP1}/api/signals`] as any).signals[0].entryTime = (currentCandle + 60) * 1000;
    (routes[`${APP1}/api/signals`] as any).signals[0].signalAt = (currentCandle + 55) * 1000;

    const res = await aggregate();
    const p = findPair(res, "USDCOP_otc");

    const ahead = p.candles.find((c: any) => c.candleTime === currentCandle + 60)!;
    expect(ahead.consensus.level).toBe("1-only");
    expect(ahead.signals.map((s: any) => s.source)).toEqual(["app1"]);

    const current = p.candles.find((c: any) => c.candleTime === currentCandle)!;
    expect(current.consensus.level).toBe("2-agree");
    expect(current.signals.map((s: any) => s.source).sort()).toEqual(["app2", "app3"]);
  });
});

describe("candle history", () => {
  test("older candles keep their consensus instead of collapsing to none", async () => {
    routes = baseRoutes();
    const oldCandle = currentCandle - 20 * 60;
    routes[`${APP1}/api/signals`] = {
      signals: [
        { symbol: "EURUSD_otc", direction: "CALL", signalAt: (oldCandle - 5) * 1000, entryTime: oldCandle * 1000, status: "WIN" },
      ],
    };
    routes[`${APP3}/api/signals`] = {
      signals: [{ asset: "EURUSD_otc", signal: "CALL", ctime: oldCandle, result: "correct" }],
    };

    const res = await aggregate(600); // freshness window shorter than the age
    const p = findPair(res, "EURUSD_otc");
    const old = p.candles.find((c: any) => c.candleTime === oldCandle)!;

    // Under the old "is it fresher than N minutes relative to now" rule these
    // signals were dropped and every historical candle rendered empty.
    expect(old.signals.length).toBe(2);
    expect(old.consensus.level).toBe("2-agree");
    expect(old.consensus.direction).toBe("CALL");
  });

  test("a signal emitted after its candle closed does not count", async () => {
    routes = baseRoutes();
    routes[`${APP1}/api/signals`] = {
      signals: [
        {
          symbol: "GBPJPY_otc",
          direction: "CALL",
          // Emitted 10 minutes AFTER the candle it claims to predict.
          signalAt: (currentCandle + 600) * 1000,
          entryTime: currentCandle * 1000,
        },
      ],
    };
    const res = await aggregate();
    const c = findPair(res, "GBPJPY_otc").latestCandle!;

    expect(c.signals.length).toBe(0);
    expect(c.consensus.level).toBe("none");
    expect(c.consensus.invalidApps).toContain("app1");
  });
});

describe("upstream robustness", () => {
  test("a renamed response envelope still yields signals", async () => {
    routes = threeAppsAgreeing("CALL");
    // App 2 renames `rows` -> `signals`; the old parser only knew `rows` and
    // silently produced an empty App 2 column.
    const app2 = routes[`${APP2}/api/share-signals`] as any;
    routes[`${APP2}/api/share-signals`] = { timestamp: app2.timestamp, signals: app2.rows };

    const res = await aggregate();
    expect(findPair(res, "USDCOP_otc").consensus.level).toBe("3-agree");
  });

  test("NEUTRAL rows are ignored rather than voting", async () => {
    routes = threeAppsAgreeing("CALL");
    (routes[`${APP2}/api/share-signals`] as any).rows[0].signal = "NEUTRAL";
    const res = await aggregate();

    const p = findPair(res, "USDCOP_otc");
    expect(p.consensus.level).toBe("2-agree");
    expect(p.consensus.agreeingApps.sort()).toEqual(["app1", "app3"]);
    expect(p.consensus.missingApps).toContain("app2");
  });

  test("one app being down does not hide the others", async () => {
    routes = threeAppsAgreeing("CALL");
    routes[`${APP1}/api/signals`] = { __status: 503 };
    routes[`${APP1}/api/health`] = { __status: 503 };

    const res = await aggregate();
    const p = findPair(res, "USDCOP_otc");
    expect(p.consensus.level).toBe("2-agree");
    expect(p.consensus.agreeingApps.sort()).toEqual(["app2", "app3"]);
    expect(p.consensus.missingApps).toEqual(["app1"]);

    const app1 = res.apps.find((a) => a.id === "app1")!;
    expect(app1.health).toBe("down");
    expect(app1.online).toBe(false);
  });

  test("App 2 keeps serving cached candles when its live snapshot fails", async () => {
    // First poll succeeds and records the current candle...
    routes = threeAppsAgreeing("CALL");
    await aggregate();

    // ...then App 2 goes down. Its signal must still appear, flagged as cached.
    routes[`${APP2}/api/share-signals`] = { __status: 502 };
    const res = await aggregate();

    const app2 = findPair(res, "USDCOP_otc").latestCandle!.signals.find(
      (s: any) => s.source === "app2"
    );
    expect(app2).toBeDefined();
    expect(app2!.cached).toBe(true);
    expect(app2!.direction).toBe("CALL");
  });

  test("app statuses report row counts for every app", async () => {
    routes = threeAppsAgreeing("CALL");
    const res = await aggregate();
    const byId = Object.fromEntries(res.apps.map((a) => [a.id, a]));

    expect(byId.app1.health).toBe("ok");
    expect(byId.app2.health).toBe("ok");
    expect(byId.app3.health).toBe("ok");
    expect(byId.app2.rawCount).toBe(1);
    expect(byId.app2.signalCount).toBeGreaterThanOrEqual(1);
    expect(byId.app2.activeStreams).toBe(3);
  });
});
