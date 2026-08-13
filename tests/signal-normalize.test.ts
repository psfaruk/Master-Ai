/**
 * Unit tests for the shared normalization helpers.
 *
 * Run with:  bun test tests/
 */

import { describe, expect, test } from "bun:test";
import {
  canonicalPair,
  candleFloor,
  displayPairFromAsset,
  isSignalValidForCandle,
  parseDirection,
  pickArray,
  pickField,
  resolveClockToCandle,
  toUnixSeconds,
} from "../src/lib/signal-normalize";

describe("toUnixSeconds", () => {
  test("passes seconds through", () => {
    expect(toUnixSeconds(1786000000)).toBe(1786000000);
  });

  test("converts milliseconds to seconds", () => {
    // This is the bug that put App 3 candles ~53,000 years in the future.
    expect(toUnixSeconds(1786000000000)).toBe(1786000000);
  });

  test("converts microseconds to seconds", () => {
    expect(toUnixSeconds(1786000000000000)).toBe(1786000000);
  });

  test("parses numeric strings and ISO dates", () => {
    expect(toUnixSeconds("1786000000")).toBe(1786000000);
    expect(toUnixSeconds("2026-08-13T04:49:00Z")).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
  });

  test("returns 0 for junk", () => {
    expect(toUnixSeconds(null)).toBe(0);
    expect(toUnixSeconds(undefined)).toBe(0);
    expect(toUnixSeconds("")).toBe(0);
    expect(toUnixSeconds("not a time")).toBe(0);
    expect(toUnixSeconds(-5)).toBe(0);
  });
});

describe("canonicalPair", () => {
  test("all three apps' spellings collapse to one key", () => {
    const expected = "USDCOP_otc";
    expect(canonicalPair("USDCOP_otc")).toBe(expected); // App 3
    expect(canonicalPair("USDCOP-OTC")).toBe(expected);
    expect(canonicalPair("usdcop_otc")).toBe(expected);
    expect(canonicalPair("USD/COP OTC")).toBe(expected); // display-style
    expect(canonicalPair("USD/COP (OTC)")).toBe(expected);
    expect(canonicalPair("  USDCOP otc ")).toBe(expected);
  });

  test("non-OTC pairs keep no suffix", () => {
    expect(canonicalPair("EURUSD")).toBe("EURUSD");
    expect(canonicalPair("EUR/USD")).toBe("EURUSD");
  });

  test("OTC is only stripped as a whole word", () => {
    // "OTCUSD" is a real ticker shape, not an OTC marker.
    expect(canonicalPair("OTCUSD")).toBe("OTCUSD");
  });

  test("rejects unusable input", () => {
    expect(canonicalPair(null)).toBe("");
    expect(canonicalPair("")).toBe("");
    expect(canonicalPair("///")).toBe("");
  });
});

describe("displayPairFromAsset", () => {
  test("splits on a known quote currency", () => {
    expect(displayPairFromAsset("USDCOP_otc")).toBe("USD/COP OTC");
    expect(displayPairFromAsset("EURUSD")).toBe("EUR/USD");
    expect(displayPairFromAsset("BTCUSDT")).toBe("BTC/USDT");
  });

  test("does not mangle names it cannot split", () => {
    // The old blind slice(0,3)/slice(3) produced "APP/LE".
    expect(displayPairFromAsset("APPLE")).toBe("APPLE");
  });
});

describe("resolveClockToCandle", () => {
  // 2026-08-13T04:49:30Z
  const ref = Math.floor(Date.UTC(2026, 7, 13, 4, 49, 30) / 1000);

  test("uses the string verbatim when the source really is UTC", () => {
    expect(resolveClockToCandle("04:49", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
  });

  test("recovers the right candle when the source renders another timezone", () => {
    // App 2 rendering UTC+6 says "10:49" for the same candle. Parsed as UTC
    // that landed 6 hours away and could never align with App 1 / App 3.
    expect(resolveClockToCandle("10:49", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
    // Same for a negative offset (broker time UTC-3).
    expect(resolveClockToCandle("01:49", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
  });

  test("handles midnight wrap-around", () => {
    const midnightRef = Math.floor(Date.UTC(2026, 7, 13, 0, 0, 20) / 1000);
    // "23:59" is the previous day's candle, not 24h in the future.
    expect(resolveClockToCandle("23:59", midnightRef)).toBe(Date.UTC(2026, 7, 12, 23, 59) / 1000);
  });

  test("falls back to the reference candle for junk or half-hour zones", () => {
    expect(resolveClockToCandle("", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
    expect(resolveClockToCandle("garbage", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
    expect(resolveClockToCandle("99:99", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
    // UTC+5:30 renders "10:19" — 30 minutes off on the minute hand, which we
    // cannot recover, so we trust our own clock instead of guessing.
    expect(resolveClockToCandle("10:19", ref)).toBe(Date.UTC(2026, 7, 13, 4, 49) / 1000);
  });
});

describe("isSignalValidForCandle", () => {
  const candle = Date.UTC(2026, 7, 13, 4, 50) / 1000;

  test("accepts a prediction emitted just before the candle", () => {
    expect(isSignalValidForCandle(candle - 20, candle)).toBe(true);
  });

  test("accepts a signal emitted during the candle", () => {
    expect(isSignalValidForCandle(candle + 30, candle)).toBe(true);
  });

  test("rejects a signal emitted long after the candle closed (look-ahead)", () => {
    expect(isSignalValidForCandle(candle + 600, candle)).toBe(false);
  });

  test("rejects a signal emitted absurdly early", () => {
    expect(isSignalValidForCandle(candle - 3600, candle)).toBe(false);
  });

  test("trusts the bucket when the source gave no timestamp", () => {
    expect(isSignalValidForCandle(0, candle)).toBe(true);
  });

  test("stays valid for old candles", () => {
    // The old code tested freshness against NOW, so every historical candle
    // was discarded and the candle-history table was permanently blank.
    const oldCandle = candle - 6 * 3600;
    expect(isSignalValidForCandle(oldCandle - 10, oldCandle)).toBe(true);
  });
});

describe("shape tolerance", () => {
  test("pickArray finds the payload whatever the envelope is called", () => {
    expect(pickArray({ rows: [1, 2] }, ["rows", "signals"])).toEqual([1, 2]);
    expect(pickArray({ signals: [1] }, ["rows", "signals"])).toEqual([1]);
    expect(pickArray([3, 4], ["rows"])).toEqual([3, 4]);
    expect(pickArray({ data: [{ a: 1 }] }, ["rows", "signals"])).toEqual([{ a: 1 }]);
    expect(pickArray(null, ["rows"])).toEqual([]);
  });

  test("pickField skips empty values", () => {
    expect(pickField({ a: "", b: "x" }, ["a", "b"])).toBe("x");
    expect(pickField({ a: null, b: 0 }, ["a", "b"])).toBe(0);
    expect(pickField(null, ["a"])).toBeUndefined();
  });

  test("parseDirection normalizes synonyms and rejects neutral", () => {
    expect(parseDirection("call")).toBe("CALL");
    expect(parseDirection(" BUY ")).toBe("CALL");
    expect(parseDirection("PUT")).toBe("PUT");
    expect(parseDirection("down")).toBe("PUT");
    expect(parseDirection("NEUTRAL")).toBeNull();
    expect(parseDirection("—")).toBeNull();
    expect(parseDirection(undefined)).toBeNull();
  });
});

describe("candleFloor", () => {
  test("floors to the minute", () => {
    expect(candleFloor(1786430999)).toBe(1786430940);
    expect(candleFloor(0)).toBe(0);
  });
});
