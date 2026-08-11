"""
Backtest Engine for QX Signal Aggregator
-----------------------------------------
Cross-checks the consensus logic against historical data from all 3 source apps
and computes real-world accuracy (win rate) for each consensus level
(3-agree / 2-agree / conflict / single).

Strategy:
1. Pull all available historical signals from each app:
   - App1 (Minimum Pair): GET /api/signals -> { signals: [...] } with status (WIN/LOSS/DRAW/VOID)
   - App2 (Binary Signal Terminal): GET /api/agent/decisions?limit=N -> { decisions: [...] } (no accuracy field)
   - App3 (OTC Live Trading): GET /api/signals?limit=N -> [...] with result (correct/wrong/draw)
2. Normalize into unified tuples: (pair, ts_unix_sec, direction, outcome_binary)
   outcome_binary: 1 = win, 0 = loss, None = unknown
3. For each pair, build a timeline of (ts, app, direction, outcome).
4. For each pair, for each minute timestamp, look at which apps fired within +/- 60s window.
   Compute consensus level and direction.
5. Determine the consensus "outcome" by majority outcome of agreeing apps.
6. Print summary + per-pair breakdown + per-direction stats.
"""

import json
import urllib.request
import os
from collections import defaultdict, Counter
from datetime import datetime, timezone

SOURCES = {
    "app1": {
        "name": "Minimum Pair",
        "url": "https://minimum-pair-production.up.railway.app/api/signals",
    },
    "app2": {
        "name": "Binary Signal Terminal",
        "url": "https://binary-signals-app-production.up.railway.app/api/agent/decisions?limit=500",
    },
    "app3": {
        "name": "OTC Live Trading",
        "url": "https://otc-live-trading-production.up.railway.app/api/signals?limit=500",
    },
}


def fetch_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "qx-backtest/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def normalize_app1(d):
    pair = d.get("symbol")
    if not pair: return None
    ts_ms = d.get("signalAt") or d.get("entryTime") or 0
    ts = ts_ms // 1000 if ts_ms > 1e12 else int(ts_ms)
    direction = (d.get("direction") or "").upper()
    if direction not in ("CALL", "PUT"): return None
    status = d.get("status")
    outcome = None
    if status == "WIN": outcome = 1
    elif status == "LOSS": outcome = 0
    elif status in ("DRAW", "VOID"): outcome = None
    return {"source": "app1", "pair": pair, "ts": ts, "direction": direction,
            "outcome": outcome, "raw_status": status}


def normalize_app2(d):
    pair = d.get("asset")
    if not pair: return None
    ts = int(d.get("ts") or 0)
    direction = (d.get("signal") or "").upper()
    if direction not in ("CALL", "PUT"): return None
    return {"source": "app2", "pair": pair, "ts": ts, "direction": direction,
            "outcome": None, "raw_status": d.get("verdict")}


def normalize_app3(d):
    pair = d.get("asset")
    if not pair: return None
    ts = int(d.get("ctime") or 0)
    direction = (d.get("signal") or "").upper()
    if direction not in ("CALL", "PUT"): return None
    result = d.get("result")
    outcome = None
    if result == "correct": outcome = 1
    elif result == "wrong": outcome = 0
    elif result == "draw": outcome = None
    return {"source": "app3", "pair": pair, "ts": ts, "direction": direction,
            "outcome": outcome, "raw_status": result}


def collect_all_signals():
    all_signals = []
    print("[1/4] Fetching App1 (Minimum Pair)...")
    try:
        d = fetch_json(SOURCES["app1"]["url"])
        arr = d.get("signals", []) if isinstance(d, dict) else d
        for s in arr:
            n = normalize_app1(s)
            if n: all_signals.append(n)
        print(f"   -> {len(arr)} raw, {sum(1 for x in all_signals if x['source']=='app1')} normalized")
    except Exception as e:
        print(f"   !! App1 failed: {e}")

    print("[2/4] Fetching App2 (Binary Signal Terminal)...")
    try:
        d = fetch_json(SOURCES["app2"]["url"])
        arr = d.get("decisions", []) if isinstance(d, dict) else d
        n2 = 0
        for s in arr:
            n = normalize_app2(s)
            if n: all_signals.append(n); n2 += 1
        print(f"   -> {len(arr)} raw, {n2} normalized")
    except Exception as e:
        print(f"   !! App2 failed: {e}")

    print("[3/4] Fetching App3 (OTC Live Trading)...")
    try:
        d = fetch_json(SOURCES["app3"]["url"])
        arr = d if isinstance(d, list) else d.get("signals", [])
        n3 = 0
        for s in arr:
            n = normalize_app3(s)
            if n: all_signals.append(n); n3 += 1
        print(f"   -> {len(arr)} raw, {n3} normalized")
    except Exception as e:
        print(f"   !! App3 failed: {e}")

    return all_signals


def build_pair_timeline(signals):
    by_pair = defaultdict(list)
    for s in signals:
        by_pair[s["pair"]].append(s)
    for pair in by_pair:
        by_pair[pair].sort(key=lambda x: x["ts"])
    return by_pair


def find_consensus_clusters(signals_for_pair, window_sec=60):
    clusters = []
    seen_signatures = set()
    arr = signals_for_pair
    n = len(arr)
    for i, anchor in enumerate(arr):
        members = [anchor]
        for j in range(n):
            if j == i: continue
            other = arr[j]
            if abs(other["ts"] - anchor["ts"]) <= window_sec:
                members.append(other)
        apps_in = tuple(sorted(set(m["source"] for m in members)))
        ts_min = min(m["ts"] for m in members)
        sig = (apps_in, ts_min // 60)
        if sig in seen_signatures: continue
        seen_signatures.add(sig)
        per_app = {}
        for m in members:
            cur = per_app.get(m["source"])
            if cur is None or m["ts"] > cur["ts"]:
                per_app[m["source"]] = m
        clusters.append({"ts_anchor": anchor["ts"], "apps": per_app, "n_apps": len(per_app)})
    return clusters


def classify_cluster(cluster):
    apps = cluster["apps"]
    n = len(apps)
    if n == 0: return None
    directions = [a["direction"] for a in apps.values()]
    call_c = sum(1 for d in directions if d == "CALL")
    put_c = sum(1 for d in directions if d == "PUT")
    if call_c == n:
        direction = "CALL"
        level = "3-agree" if n == 3 else ("2-agree" if n == 2 else "1-only")
    elif put_c == n:
        direction = "PUT"
        level = "3-agree" if n == 3 else ("2-agree" if n == 2 else "1-only")
    elif call_c >= 2 or put_c >= 2:
        direction = "CALL" if call_c > put_c else "PUT"
        level = "conflict"
    else:
        direction = None
        level = "conflict"

    if level in ("3-agree", "2-agree", "1-only"):
        agreeing_outcomes = [a["outcome"] for a in apps.values() if a["direction"] == direction and a["outcome"] is not None]
    else:
        agreeing_outcomes = [a["outcome"] for a in apps.values() if a["direction"] == direction and a["outcome"] is not None]

    n_win = sum(1 for o in agreeing_outcomes if o == 1)
    n_loss = sum(1 for o in agreeing_outcomes if o == 0)
    n_unknown = len([a for a in apps.values() if a["outcome"] is None and a["direction"] == direction])

    if not agreeing_outcomes:
        outcome = None
    elif all(o == 1 for o in agreeing_outcomes):
        outcome = 1
    else:
        outcome = 0

    return {
        "level": level, "direction": direction, "n_apps": n,
        "call_count": call_c, "put_count": put_c,
        "agreeing_win": n_win, "agreeing_loss": n_loss, "agreeing_unknown": n_unknown,
        "outcome": outcome, "ts": cluster["ts_anchor"],
    }


def run_backtest():
    print("===== QX Signal Aggregator Backtest =====")
    print(f"Started at: {datetime.now(timezone.utc).isoformat()}")
    print()

    signals = collect_all_signals()
    print()
    print(f"[4/4] Total normalized signals: {len(signals)}")

    by_pair = build_pair_timeline(signals)
    print(f"     Distinct pairs: {len(by_pair)}")

    all_clusters = []
    per_pair_clusters = {}
    for pair, arr in by_pair.items():
        clusters = find_consensus_clusters(arr, window_sec=60)
        per_pair_clusters[pair] = []
        for c in clusters:
            cls = classify_cluster(c)
            if cls:
                cls["pair"] = pair
                all_clusters.append(cls)
                per_pair_clusters[pair].append(cls)

    print(f"     Total clusters found: {len(all_clusters)}")
    print()

    print("=" * 70)
    print("CONSENSUS LEVEL SUMMARY")
    print("=" * 70)
    level_stats = defaultdict(lambda: {"total": 0, "win": 0, "loss": 0, "unknown": 0,
                                       "call": 0, "put": 0, "call_win": 0, "call_loss": 0,
                                       "put_win": 0, "put_loss": 0})
    for c in all_clusters:
        s = level_stats[c["level"]]
        s["total"] += 1
        if c["outcome"] == 1: s["win"] += 1
        elif c["outcome"] == 0: s["loss"] += 1
        else: s["unknown"] += 1
        if c["direction"] == "CALL":
            s["call"] += 1
            if c["outcome"] == 1: s["call_win"] += 1
            elif c["outcome"] == 0: s["call_loss"] += 1
        elif c["direction"] == "PUT":
            s["put"] += 1
            if c["outcome"] == 1: s["put_win"] += 1
            elif c["outcome"] == 0: s["put_loss"] += 1

    print(f"{'Level':<12} {'Total':>8} {'Win':>6} {'Loss':>6} {'Unknown':>9} {'WinRate':>10} {'CALL':>6} {'PUT':>6}")
    print("-" * 70)
    for level in ["3-agree", "2-agree", "conflict", "1-only"]:
        s = level_stats[level]
        graded = s["win"] + s["loss"]
        wr = (s["win"] / graded * 100) if graded > 0 else 0
        print(f"{level:<12} {s['total']:>8} {s['win']:>6} {s['loss']:>6} {s['unknown']:>9} "
              f"{wr:>9.1f}% {s['call']:>6} {s['put']:>6}")

    print()
    print("=" * 70)
    print("DIRECTION BREAKDOWN (within consensus levels)")
    print("=" * 70)
    print(f"{'Level':<12} {'Dir':<5} {'Win':>6} {'Loss':>6} {'WinRate':>10}")
    print("-" * 50)
    for level in ["3-agree", "2-agree", "conflict", "1-only"]:
        s = level_stats[level]
        for d, w, l in [("CALL", s["call_win"], s["call_loss"]),
                        ("PUT", s["put_win"], s["put_loss"])]:
            graded = w + l
            wr = (w / graded * 100) if graded > 0 else 0
            print(f"{level:<12} {d:<5} {w:>6} {l:>6} {wr:>9.1f}%")

    print()
    print("=" * 70)
    print("TOP PAIRS BY CLUSTER COUNT")
    print("=" * 70)
    pair_summary = []
    for pair, clusters in per_pair_clusters.items():
        if not clusters: continue
        win = sum(1 for c in clusters if c["outcome"] == 1)
        loss = sum(1 for c in clusters if c["outcome"] == 0)
        graded = win + loss
        wr = (win / graded * 100) if graded > 0 else None
        three = sum(1 for c in clusters if c["level"] == "3-agree")
        two = sum(1 for c in clusters if c["level"] == "2-agree")
        pair_summary.append((pair, len(clusters), win, loss, graded - win - loss, three, two, wr))
    pair_summary.sort(key=lambda x: x[1], reverse=True)
    print(f"{'Pair':<14} {'Total':>6} {'Win':>6} {'Loss':>6} {'Unk':>5} {'3-agree':>9} {'2-agree':>9} {'WinRate':>10}")
    print("-" * 75)
    for row in pair_summary[:15]:
        pair, total, win, loss, unk, three, two, wr = row
        wr_str = f"{wr:.1f}%" if wr is not None else "—"
        print(f"{pair:<14} {total:>6} {win:>6} {loss:>6} {unk:>5} {three:>9} {two:>9} {wr_str:>10}")

    print()
    print("=" * 70)
    print("SAMPLE 3-AGREE CLUSTERS (first 10)")
    print("=" * 70)
    three_agree = [c for c in all_clusters if c["level"] == "3-agree"]
    if not three_agree:
        print("  No 3-agree clusters found in historical data.")
        print("  (Likely because App1 token expired — App1 has very few recent signals)")
    else:
        for c in three_agree[:10]:
            ts_str = datetime.fromtimestamp(c["ts"]).strftime("%Y-%m-%d %H:%M:%S")
            outcome_str = "WIN" if c["outcome"] == 1 else ("LOSS" if c["outcome"] == 0 else "—")
            print(f"  {ts_str}  {c['pair']:<14} {c['direction']:<5} {outcome_str}")

    print()
    print("=" * 70)
    print("SAMPLE 2-AGREE CLUSTERS (first 10 with known outcome)")
    print("=" * 70)
    two_agree_graded = [c for c in all_clusters if c["level"] == "2-agree" and c["outcome"] is not None]
    for c in two_agree_graded[:10]:
        ts_str = datetime.fromtimestamp(c["ts"]).strftime("%Y-%m-%d %H:%M:%S")
        outcome_str = "WIN" if c["outcome"] == 1 else "LOSS"
        print(f"  {ts_str}  {c['pair']:<14} {c['direction']:<5} {outcome_str}")

    print()
    print("=" * 70)
    print("SOURCE APP INDIVIDUAL ACCURACY")
    print("=" * 70)
    src_stats = defaultdict(lambda: {"total": 0, "win": 0, "loss": 0, "unknown": 0})
    for s in signals:
        src = s["source"]
        src_stats[src]["total"] += 1
        if s["outcome"] == 1: src_stats[src]["win"] += 1
        elif s["outcome"] == 0: src_stats[src]["loss"] += 1
        else: src_stats[src]["unknown"] += 1
    print(f"{'App':<6} {'Name':<28} {'Total':>6} {'Win':>6} {'Loss':>6} {'Unknown':>9} {'WinRate':>10}")
    print("-" * 75)
    for src in ["app1", "app2", "app3"]:
        s = src_stats[src]
        name = SOURCES[src]["name"]
        graded = s["win"] + s["loss"]
        wr = (s["win"] / graded * 100) if graded > 0 else 0
        print(f"{src:<6} {name:<28} {s['total']:>6} {s['win']:>6} {s['loss']:>6} {s['unknown']:>9} {wr:>9.1f}%")

    print()
    print("=" * 70)
    print("VERIFICATION VERDICT")
    print("=" * 70)
    s3 = level_stats["3-agree"]
    s2 = level_stats["2-agree"]
    s1 = level_stats["1-only"]
    g3 = s3["win"] + s3["loss"]
    g2 = s2["win"] + s2["loss"]
    g1 = s1["win"] + s1["loss"]
    print(f"3-agree graded: {g3} | winrate: {(s3['win']/g3*100) if g3 else 0:.1f}%")
    print(f"2-agree graded: {g2} | winrate: {(s2['win']/g2*100) if g2 else 0:.1f}%")
    print(f"1-only graded:  {g1} | winrate: {(s1['win']/g1*100) if g1 else 0:.1f}%")
    print()
    if g3 >= 5 and g2 >= 5 and g1 >= 5:
        wr3 = s3["win"] / g3 * 100
        wr2 = s2["win"] / g2 * 100
        wr1 = s1["win"] / g1 * 100
        if wr3 >= wr2 >= wr1:
            print("✓ CONSENSUS LOGIC VALIDATED: 3-agree >= 2-agree >= 1-only accuracy")
        elif wr3 >= wr1:
            print("✓ PARTIAL VALIDATION: 3-agree outperforms single-bot, but 2-agree anomaly detected")
        else:
            print("✗ ANOMALY: consensus levels do not show expected accuracy improvement")
    else:
        print("? INSUFFICIENT GRADED DATA: need at least 5 graded signals per level for a confident verdict")
        print(f"  (have: 3-agree={g3}, 2-agree={g2}, 1-only={g1})")

    return {
        "level_stats": dict(level_stats),
        "total_clusters": len(all_clusters),
        "total_signals": len(signals),
        "src_stats": dict(src_stats),
    }


if __name__ == "__main__":
    result = run_backtest()
    out_path = "/home/z/my-project/download/backtest_result.json"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    serializable = {
        "total_signals": result["total_signals"],
        "total_clusters": result["total_clusters"],
        "levels": {k: dict(v) for k, v in result["level_stats"].items()},
        "sources": {k: dict(v) for k, v in result["src_stats"].items()},
    }
    with open(out_path, "w") as f:
        json.dump(serializable, f, indent=2, default=str)
    print(f"\n[Saved] {out_path}")
