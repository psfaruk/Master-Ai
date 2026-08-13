/**
 * Shared normalization helpers
 * ----------------------------
 * Every module that reads the 3 source apps (aggregator, app2-cache,
 * backtest-runner) MUST go through these helpers. Previously each module
 * re-implemented pair parsing / timestamp parsing slightly differently, which
 * meant the same upstream row could end up under two different pair keys or
 * two different candle buckets depending on which code path read it — and a
 * signal that lands in a different bucket can never form a consensus.
 *
 * Three classes of bug live here, all of which used to break cross-app
 * alignment (especially for App 2):
 *
 *   1. Pair keys.  App 1 says `symbol`, App 2 says `pair`, App 3 says `asset`,
 *      and they do not always use the same spelling ("USDCOP_otc" vs
 *      "USDCOP-OTC" vs "USD/COP OTC"). Consensus is a Map lookup on that
 *      string, so any spelling drift silently drops an app from the group.
 *
 *   2. Timestamps.  Some fields are unix seconds, some are milliseconds, some
 *      are ISO strings. A millisecond value read as seconds lands the candle
 *      ~53,000 years in the future, which both hides the signal and poisons
 *      "newest candle" selection for the whole pair.
 *
 *   3. Wall-clock strings.  App 2 reports only "HH:MM". Parsing that as UTC is
 *      only correct if App 2 renders UTC; if it renders any other whole-hour
 *      timezone, every App 2 signal lands hours away from App 1 / App 3 and
 *      never joins a candle.
 */

export type AppId = "app1" | "app2" | "app3";

/** Seconds per candle. Everything in this project is 1-minute candles. */
export const CANDLE_SEC = 60;

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Coerce anything that looks like a timestamp into unix SECONDS.
 *
 * Accepts unix seconds, unix milliseconds, unix microseconds, numeric strings
 * and ISO-8601 strings. Returns 0 when the value is missing or unparseable, so
 * callers can test with a simple `> 0`.
 */
export function toUnixSeconds(value: unknown): number {
  if (value == null) return 0;

  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    n = Number(trimmed);
    if (!Number.isFinite(n)) {
      // Not numeric — try to parse as a date string ("2026-08-13T04:49:00Z").
      const parsed = Date.parse(trimmed);
      if (!Number.isFinite(parsed)) return 0;
      return Math.floor(parsed / 1000);
    }
  } else {
    return 0;
  }

  if (!Number.isFinite(n) || n <= 0) return 0;

  // Magnitude test. A sane unix-seconds timestamp for "now" is ~1.7e9.
  if (n >= 1e14) return Math.floor(n / 1e6); // microseconds
  if (n >= 1e11) return Math.floor(n / 1e3); // milliseconds
  return Math.floor(n);
}

/** Floor a unix-seconds timestamp to the start of its 1-minute candle. */
export function candleFloor(tsSec: number): number {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return 0;
  return Math.floor(tsSec / CANDLE_SEC) * CANDLE_SEC;
}

/**
 * Resolve a wall-clock string ("HH:MM" or "HH:MM:SS") into a unix-seconds
 * candle time, using `refSec` (a trustworthy absolute time, e.g. the upstream
 * server timestamp or our own clock) to pin down the date AND the timezone.
 *
 * Strategy, in order:
 *   1. Interpret the string as UTC on ref's date (± a day for wrap-around).
 *      If that lands within `maxDriftSec` of ref, App 2 really is emitting UTC
 *      and we use it verbatim.
 *   2. Otherwise assume the source renders some other whole-hour timezone. The
 *      MINUTE is timezone-independent for whole-hour offsets, so pick the
 *      instant nearest to ref whose minute-of-hour matches. That recovers the
 *      correct candle without knowing which timezone the app uses.
 *   3. If even that is implausible (e.g. a half-hour timezone, or a garbage
 *      string), fall back to ref's own candle. For a live snapshot — which is
 *      the only thing App 2 exposes — ref's candle is the right answer.
 *
 * `maxDriftSec` defaults to 90 minutes: comfortably more than any sane clock
 * skew, but far less than the 1-hour granularity that distinguishes timezones.
 */
export function resolveClockToCandle(
  timeStr: string,
  refSec: number,
  maxDriftSec: number = 90 * 60
): number {
  const refCandle = candleFloor(refSec);
  if (!timeStr) return refCandle;

  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return refCandle;

  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return refCandle;

  // --- 1. Try a literal UTC reading, allowing day wrap in both directions.
  const ref = new Date(refSec * 1000);
  const sameDayUtc =
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hh, mm, 0) / 1000;
  const utcCandidates = [sameDayUtc - 86400, sameDayUtc, sameDayUtc + 86400];
  let bestUtc = utcCandidates[0];
  for (const c of utcCandidates) {
    if (Math.abs(c - refSec) < Math.abs(bestUtc - refSec)) bestUtc = c;
  }
  if (Math.abs(bestUtc - refSec) <= maxDriftSec) return candleFloor(bestUtc);

  // --- 2. Timezone-agnostic recovery: match on minute-of-hour only.
  const refMinuteOfHour = ref.getUTCMinutes();
  let deltaMin = mm - refMinuteOfHour;
  // Wrap into [-30, 30) so we pick the nearest matching minute.
  if (deltaMin >= 30) deltaMin -= 60;
  if (deltaMin < -30) deltaMin += 60;
  const nearest = refCandle + deltaMin * 60;
  // Only trust it if it is genuinely close — a live snapshot should never be
  // more than a few candles away from the reference clock.
  if (Math.abs(nearest - refSec) <= 5 * 60) return candleFloor(nearest);

  // --- 3. Give up on the string; the reference clock is more reliable.
  return refCandle;
}

// ---------------------------------------------------------------------------
// Pair identity
// ---------------------------------------------------------------------------

// Matches an "otc" marker that is delimited by a separator (or the string
// edge) on both sides. A plain \b is not enough here: "_" is a word character,
// so \botc\b never matched the most common spelling of all, "USDCOP_otc" —
// which meant App 3's key ("USDCOP_otc") and App 2's ("USD/COP OTC") stayed
// two different pairs and could never form a consensus.
const OTC_RE = /(^|[\s_\-()/])otc(?=$|[\s_\-()/])/i;

/**
 * Canonical pair key, shared by all 3 apps: uppercase alphanumerics plus an
 * `_otc` suffix for OTC assets.
 *
 *   "USDCOP_otc"    -> "USDCOP_otc"
 *   "USD/COP OTC"   -> "USDCOP_otc"
 *   "usdcop-otc"    -> "USDCOP_otc"
 *   "EURUSD"        -> "EURUSD"
 *
 * Returns "" for unusable input so callers can skip the row.
 */
export function canonicalPair(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";

  const isOtc = OTC_RE.test(s);
  const base = s.replace(OTC_RE, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!base) return "";
  return isOtc ? `${base}_otc` : base;
}

/** True when the canonical pair is an OTC (synthetic weekend) asset. */
export function isOtcPair(canonical: string): boolean {
  return canonical.endsWith("_otc");
}

export function classifyPair(canonical: string): "otc" | "real" {
  return isOtcPair(canonical) ? "otc" : "real";
}

/** Quote currencies we know about, longest first so "USDT" beats "USD". */
const QUOTES = [
  "USDT", "USDC", "BUSD",
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD",
  "CNH", "CNY", "HKD", "SGD", "TRY", "ZAR", "MXN", "BRL", "INR", "RUB",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "THB", "IDR", "PHP", "COP",
  "ARS", "CLP", "PEN", "EGP", "NGN", "PKR", "BDT", "VND", "KES", "SAR",
  "AED", "QAR", "MAD", "DZD", "TND", "JOD", "BHD", "KWD", "OMR", "LBP",
];

/**
 * Human-readable display form of a canonical pair.
 *
 *   "USDCOP_otc" -> "USD/COP OTC"
 *   "BTCUSDT"    -> "BTC/USDT"
 *   "APPLE"      -> "APPLE"   (no known split — left alone rather than
 *                              blindly cut at 3 chars, which used to produce
 *                              nonsense like "APP/LE")
 */
export function displayPairFromAsset(canonical: string): string {
  const otc = isOtcPair(canonical);
  const base = otc ? canonical.slice(0, -4) : canonical;
  const suffix = otc ? " OTC" : "";

  for (const q of QUOTES) {
    if (base.length > q.length && base.endsWith(q)) {
      return `${base.slice(0, base.length - q.length)}/${q}${suffix}`;
    }
  }
  // Classic 6-letter forex code with an unknown quote — split down the middle.
  if (base.length === 6) return `${base.slice(0, 3)}/${base.slice(3)}${suffix}`;
  return `${base}${suffix}`;
}

// ---------------------------------------------------------------------------
// Shape tolerance
// ---------------------------------------------------------------------------

/**
 * Pull the signal array out of a response whose envelope key we are not sure
 * about. The source apps have changed their envelope before (`rows` vs
 * `signals` vs a bare array); when that happens the old code silently produced
 * zero signals for that app and the dashboard just showed an empty column.
 */
export function pickArray(data: any, keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) return v;
  }
  // Last resort: any top-level array-of-objects property.
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") return v as any[];
  }
  return [];
}

/** First non-null/non-empty value among the given keys of `row`. */
export function pickField(row: any, keys: string[]): unknown {
  if (!row || typeof row !== "object") return undefined;
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Field-name aliases, so a rename upstream doesn't blank out a column. */
export const PAIR_KEYS = ["symbol", "pair", "asset", "instrument", "ticker"];
export const DIRECTION_KEYS = ["direction", "signal", "side", "action", "type"];

/** Normalize a direction string; returns null when it isn't CALL/PUT. */
export function parseDirection(raw: unknown): "CALL" | "PUT" | null {
  const s = String(raw ?? "").toUpperCase().trim();
  if (s === "CALL" || s === "BUY" || s === "UP" || s === "LONG") return "CALL";
  if (s === "PUT" || s === "SELL" || s === "DOWN" || s === "SHORT") return "PUT";
  return null;
}

// ---------------------------------------------------------------------------
// Candle alignment
// ---------------------------------------------------------------------------

/**
 * Per-app candle offset, in whole candles, applied when bucketing a signal.
 *
 * The three apps do not all label a signal with the same candle: one may tag
 * the candle it just analysed while another tags the candle it is predicting.
 * When that happens the apps sit in adjacent buckets and can never agree.
 *
 * Defaults are 0 (no shift) — set these only if `/api/diag` reports a
 * consistent non-zero modal offset between two apps:
 *
 *   APP1_CANDLE_OFFSET  (candles, e.g. "-1")
 *   APP2_CANDLE_OFFSET
 *   APP3_CANDLE_OFFSET
 */
export function getCandleOffsetSec(app: AppId): number {
  const key = `${app.toUpperCase()}_CANDLE_OFFSET`;
  const raw = typeof process !== "undefined" ? process.env?.[key] : undefined;
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // Clamp to ±5 candles — anything larger is a misconfiguration, not an offset.
  const clamped = Math.max(-5, Math.min(5, Math.trunc(n)));
  return clamped * CANDLE_SEC;
}

/** How early a signal may be emitted and still count for its candle. */
export const MAX_LEAD_SEC = 5 * 60;
/** How late (after the candle opened) a signal may be emitted and still count. */
export const MAX_LAG_SEC = CANDLE_SEC + 30;

/**
 * Is this signal legitimately about `candleTime`?
 *
 * A signal counts for a candle when it was emitted shortly before that candle
 * (a prediction) or during it — not after it closed, which would be
 * look-ahead. This replaces the old "is the signal younger than N minutes
 * relative to NOW" test, which was wrong for candle-aligned consensus: it
 * threw away every historical candle's signals and made the candle-history
 * table permanently empty.
 */
export function isSignalValidForCandle(timestampSec: number, candleTime: number): boolean {
  if (!(candleTime > 0)) return false;
  // A missing/zero timestamp means the source didn't tell us when it emitted;
  // trust the candle bucket itself rather than dropping the signal.
  if (!(timestampSec > 0)) return true;
  const lead = candleTime - timestampSec;
  // lead > 0  : emitted before the candle opened (a prediction) — allow up to MAX_LEAD_SEC.
  // lead <= 0 : emitted during the candle — allow until shortly after it closed.
  return lead <= MAX_LEAD_SEC && lead >= -MAX_LAG_SEC;
}
