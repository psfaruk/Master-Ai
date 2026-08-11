/**
 * Tiny shared fetch helper used by both signal-aggregator and backtest-runner.
 * Returns parsed JSON with a hard timeout.
 */

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = 10000
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "qx-aggregator/1.0" },
      cache: "no-store",
    });
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } finally {
    clearTimeout(t);
  }
}
