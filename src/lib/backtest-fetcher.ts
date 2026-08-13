/**
 * Tiny shared fetch helper used by the aggregator, the App 2 cache and the
 * backtest runner. Returns parsed JSON with a hard timeout.
 *
 * Returns null on any failure mode that isn't worth distinguishing (empty
 * body, non-JSON body, non-2xx). Railway occasionally answers with an HTML
 * error page during a cold start; the old version parsed that to null and the
 * caller reported the app as permanently down. We now retry once on a 5xx or
 * a network error, which covers the cold-start case.
 */

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Extra attempts after the first one. Default 1. */
  retries?: number;
}

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = 10000,
  options: FetchJsonOptions = {}
): Promise<any> {
  const retries = options.retries ?? 1;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json", "User-Agent": "qx-aggregator/1.0" },
        cache: "no-store",
      });

      // 5xx is usually a cold start or a restart — worth one retry.
      if (res.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) return null;

      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null; // HTML error page or truncated body
      }
    } catch (e) {
      lastError = e;
      // Abort (timeout) and network errors get one more shot.
      if (attempt < retries) continue;
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  if (lastError) throw lastError;
  return null;
}
