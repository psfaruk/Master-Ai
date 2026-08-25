#!/usr/bin/env python3
"""Offline backtest verification gate.

``python -m app.backtest_runner`` needs the three live Railway upstreams.
This harness runs the SAME pipeline against a deterministic synthetic feed,
so the merge / grading / consensus logic can be verified in CI, on a laptop,
or anywhere the upstreams are unreachable.

It asserts the behaviours the ledger change is supposed to guarantee:

1. Baseline merge — 3 apps agreeing on N candles produce N 3-agree clusters.
2. Grading      — win/loss is computed from the real candle close, and the
                  reported win rate matches the seeded outcomes exactly.
3. Ledger replay — when App 3's history window pages out (its upstream caps
                  at 500 rows ≈ 41 min), those candles STAY 3-agree instead
                  of silently degrading to 2-agree.
4. Restart      — the same holds across a simulated process restart.
5. No inflation — replay must not duplicate clusters or invent wins.

Exit code 0 = all good; non-zero = a check failed.

    python tests/verify_backtest.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import backtest_runner as br  # noqa: E402
from app.app2_cache import CachedSignal  # noqa: E402
from app.signal_ledger import activate_ledger, ledger_stats, reset_ledger_for_tests  # noqa: E402

FAILURES: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label}: got {actual!r}, want {expected!r}")
    if not ok:
        FAILURES.append(f"{label}: got {actual!r}, want {expected!r}")


class Harness:
    """Deterministic 3-app feed with known outcomes."""

    def __init__(self, n_candles: int = 12, pair: str = "EURUSD_otc"):
        self.pair = pair
        now = int(time.time())
        self.base = ((now // 60) - n_candles - 2) * 60
        self.times = [self.base + i * 60 for i in range(n_candles)]
        # Deterministic outcome pattern: 4 wins then 2 losses, repeating.
        self.wins = [(i % 6) < 4 for i in range(n_candles)]

    # --- upstream payloads ---
    def app1_rows(self):
        return [{"pair": self.pair, "direction": "CALL", "entry_ts": t} for t in self.times]

    def app3_rows(self, paged_out: bool = False):
        if paged_out:
            return []
        return [{"pair": self.pair, "direction": "CALL", "ctime": t} for t in self.times]

    def app2_records(self):
        return [
            CachedSignal(
                pair=self.pair, candle_time=t, signal="CALL", confidence=None,
                strength=None, first_seen_sec=t - 30,
                captured_at=float((t - 30) * 1000), last_tick_age_sec=None,
                live=False, buyer_pct=0.6, seller_pct=0.4,
            )
            for t in self.times
        ]

    def grade(self, pair, candle_time, direction):
        """CALL wins when the candle closed up. Mirrors grade_signal()'s
        contract: (outcome, label)."""
        try:
            i = self.times.index(candle_time)
        except ValueError:
            return (None, "UNKNOWN")
        won = self.wins[i] if direction == "CALL" else not self.wins[i]
        return (1 if won else 0, "WIN" if won else "LOSS")

    def run(self, monkey, *, app3_paged_out: bool = False):
        rows1, rows3, recs2 = self.app1_rows(), self.app3_rows(app3_paged_out), self.app2_records()

        async def fake_fetch(url, **kw):
            if "minimum-pair" in url:
                return {"signals": rows1}
            if "otclivedata" in url and "share-signals" not in url:
                return {"signals": rows3}
            return {"signals": []}

        async def fake_refresh():
            return None

        monkey["fetch"] = br.fetch_json_with_timeout
        br.fetch_json_with_timeout = fake_fetch
        br.refresh_candles = fake_refresh
        br.grade_signal = self.grade
        br.get_all_cached_app2_signals = lambda: recs2
        br.start_app2_cache_poller = lambda: None
        br.start_candle_poller = lambda: None
        for n in ("1", "2", "3"):
            os.environ[f"APP{n}_CANDLE_OFFSET"] = "0"
        return asyncio.run(br.run_backtest())


def main() -> int:
    tmpdir = tempfile.mkdtemp(prefix="verify-backtest-")
    ledger_path = os.path.join(tmpdir, "ledger.json")
    os.environ["SIGNAL_LEDGER_FILE"] = ledger_path
    os.environ["APP2_CACHE_FILE"] = os.path.join(tmpdir, "app2.json")

    h = Harness(n_candles=12)
    expected_wins = sum(1 for w in h.wins if w)
    expected_losses = len(h.wins) - expected_wins
    expected_wr = round(expected_wins / len(h.wins) * 100, 1)
    monkey: dict = {}

    print("\n=== 1. Baseline: all 3 apps report all 12 candles ===")
    reset_ledger_for_tests()
    activate_ledger(ledger_path)
    r1 = h.run(monkey)
    lv = r1["levels"]["3-agree"]
    check("3-agree clusters", lv["total"], 12)
    check("2-agree clusters", r1["levels"]["2-agree"]["total"], 0)
    check("ledger backfilled", r1["ledgerBackfilled"], 0)

    print("\n=== 2. Grading against real candle closes ===")
    check("wins", lv["win"], expected_wins)
    check("losses", lv["loss"], expected_losses)
    check("win rate", lv["winRate"], expected_wr)

    print("\n=== 3. App 3 pages out (its 500-row / ~41min cap) ===")
    r2 = h.run(monkey, app3_paged_out=True)
    lv2 = r2["levels"]["3-agree"]
    check("3-agree survives", lv2["total"], 12)
    check("did NOT degrade to 2-agree", r2["levels"]["2-agree"]["total"], 0)
    check("backfilled from ledger", r2["ledgerBackfilled"], 12)
    check("win rate unchanged", lv2["winRate"], expected_wr)

    print("\n=== 4. Simulated process restart (Railway redeploy) ===")
    stats_before = ledger_stats()["total"]
    reset_ledger_for_tests()
    activate_ledger(ledger_path)
    check("ledger restored from disk", ledger_stats()["total"], stats_before)
    r3 = h.run(monkey, app3_paged_out=True)
    check("3-agree survives restart", r3["levels"]["3-agree"]["total"], 12)
    check("win rate survives restart", r3["levels"]["3-agree"]["winRate"], expected_wr)

    print("\n=== 5. No inflation from repeated replay ===")
    r4 = h.run(monkey, app3_paged_out=True)
    check("cluster count stable", r4["totalClusters"], r3["totalClusters"])
    check("wins not inflated", r4["levels"]["3-agree"]["win"], expected_wins)
    per_source = ledger_stats()["perSource"]
    check("app1 rows stored", per_source.get("app1", {}).get("count"), 12)
    check("app2 rows stored", per_source.get("app2", {}).get("count"), 12)
    check("app3 rows stored", per_source.get("app3", {}).get("count"), 12)

    print("\n=== 6. Per-pair history carries the detail payload ===")
    pair_entry = next(p for p in r4["perPair"] if p["pair"] == h.pair)
    row = pair_entry["history"][0]
    for key in ("app_directions", "app_outcomes", "appOutcomeLabels",
                "agreeing_apps", "app_subset_key", "level", "outcomeLabel"):
        check(f"history row has {key}", key in row, True)
    check("subset key", row["app_subset_key"], "app1+app2+app3")

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"❌ {len(FAILURES)} CHECK(S) FAILED:")
        for f in FAILURES:
            print(f"   - {f}")
        return 1
    print("✅ ALL CHECKS PASSED")
    print(f"   12 candles · {expected_wins}W/{expected_losses}L · {expected_wr}% win rate")
    print("   3-agree history held at 12 clusters across App 3 page-out AND restart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
