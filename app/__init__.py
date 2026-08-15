"""Master-Ai — Python edition.

A trading-signal aggregator dashboard. Mirrors the original Next.js/TypeScript
implementation:

- Fetches CALL/PUT signals from three Quotex signal apps hosted on Railway.
- Normalizes them into a unified schema (canonical pair keys, candle-aligned
  timestamps, unit-normalized emission times).
- Computes per-pair / per-candle consensus (3-agree / 2-agree / conflict /
  1-only).
- Grades win/loss outcomes against the actual candle close from App 3, so
  every signal — including those from App 2, which never reports an outcome
  — gets a verdict.
- Backtests the consensus strategy against the last 6 hours of history.
- Serves a simple Jinja2 dashboard plus the same five JSON endpoints the
  original Next.js app exposed.
"""

__version__ = "1.0.0"
