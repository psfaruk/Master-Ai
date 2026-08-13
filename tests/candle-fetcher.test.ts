/**
 * Unit tests for the candle-fetcher's grading logic.
 *
 * These tests don't hit the network — they verify that
 * gradeSignalAgainstCandle() correctly classifies a signal as WIN/LOSS/DRAW
 * based on the candle's open and close prices, which is the core win-rate
 * computation used by the backtest.
 */

import { describe, expect, test } from "bun:test";
import {
  gradeSignalAgainstCandle,
  type Candle,
} from "../src/lib/candle-fetcher";

function makeCandle(open: number, close: number, opts: Partial<Candle> = {}): Candle {
  return {
    pair: "TEST",
    candleTime: 1700000000,
    open,
    close,
    high: opts.high ?? null,
    low: opts.low ?? null,
    result: opts.result ?? null,
    app3Direction: opts.app3Direction ?? null,
    fetchedAt: Date.now(),
  };
}

describe("gradeSignalAgainstCandle", () => {
  test("CALL wins when close > open", () => {
    expect(gradeSignalAgainstCandle("CALL", makeCandle(100, 101))).toBe("WIN");
  });

  test("CALL loses when close < open", () => {
    expect(gradeSignalAgainstCandle("CALL", makeCandle(101, 100))).toBe("LOSS");
  });

  test("PUT wins when close < open", () => {
    expect(gradeSignalAgainstCandle("PUT", makeCandle(101, 100))).toBe("WIN");
  });

  test("PUT loses when close > open", () => {
    expect(gradeSignalAgainstCandle("PUT", makeCandle(100, 101))).toBe("LOSS");
  });

  test("DRAW when close === open exactly", () => {
    expect(gradeSignalAgainstCandle("CALL", makeCandle(100, 100))).toBe("DRAW");
    expect(gradeSignalAgainstCandle("PUT", makeCandle(100, 100))).toBe("DRAW");
  });

  test("DRAW when |close - open| < epsilon (floating-point noise)", () => {
    // 1e-12 is well below the 1e-9 epsilon; this should classify as DRAW,
    // not as a tiny win for whichever side happens to round the right way.
    expect(gradeSignalAgainstCandle("CALL", makeCandle(100, 100 + 1e-12))).toBe("DRAW");
    expect(gradeSignalAgainstCandle("PUT",  makeCandle(100, 100 - 1e-12))).toBe("DRAW");
  });

  test("UNKNOWN when candle is null (missing data)", () => {
    expect(gradeSignalAgainstCandle("CALL", null)).toBe("UNKNOWN");
    expect(gradeSignalAgainstCandle("PUT",  null)).toBe("UNKNOWN");
  });

  test("UNKNOWN when close is missing (candle hasn't closed yet)", () => {
    const c = makeCandle(100, NaN);
    expect(gradeSignalAgainstCandle("CALL", c)).toBe("UNKNOWN");
  });

  test("UNKNOWN when open is missing", () => {
    const c = makeCandle(NaN, 100);
    expect(gradeSignalAgainstCandle("CALL", c)).toBe("UNKNOWN");
  });

  test("works with very small price moves (forex pairs)", () => {
    // USDCOP-like pair: open 3145.51, close 3145.39 — PUT signal wins.
    expect(gradeSignalAgainstCandle("PUT", makeCandle(3145.51, 3145.39))).toBe("WIN");
    expect(gradeSignalAgainstCandle("CALL", makeCandle(3145.51, 3145.39))).toBe("LOSS");
  });

  test("works with very large price values (JPY pairs)", () => {
    // USDJPY-like pair: open 159.507, close 159.512 — CALL signal wins.
    expect(gradeSignalAgainstCandle("CALL", makeCandle(159.507, 159.512))).toBe("WIN");
  });
});
