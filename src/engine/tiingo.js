// src/engine/tiingo.js
// Fetches price metrics (NAV, momentum, Sharpe/riskAdj) from Tiingo for all
// fund tickers. Results are cached in Supabase tiingo_cache (1-day TTL).
//
// ⚠️  All Supabase calls route through supaFetch() in cache.js.
// ⚠️  No localStorage. No direct Supabase calls.
// ⚠️  200ms delay between live Tiingo fetches (free-tier rate limit).
// ⚠️  429 handling: serve stale cache if available, else emit 5.0 fallbacks.

import { getTiingoCache, saveTiingoCache } from '../services/cache.js';
import { supaFetch }                        from '../services/api.js';
import { MONEY_MARKET_TICKERS }             from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DELAY_MS = 200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Sample standard deviation of an array of numbers.
 * Returns 0 if fewer than 2 elements.
 */
function sampleStdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Returns a YYYY-MM-DD date string for `daysBack` days in the past.
 */
function isoDateAgo(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

/**
 * Computes { nav, momentum, sharpe, riskAdj } from a Tiingo prices array.
 *
 * Tiingo returns rows oldest-first when queried with startDate/endDate.
 * Each row may have adjClose or close; adjClose is preferred.
 *
 * momentum scaling:
 *   neutral (0%) → 5.0
 *   +5% over 63 days → ~7.5  (multiplier 50)
 *   -5% over 63 days → ~2.5
 *   clamped 1–10
 *
 * riskAdj:
 *   sharpe_raw = (avg_daily_return / std_dev_daily) * sqrt(252)
 *   riskAdj = clamp(5 + sharpe_raw * 2, 1, 10)
 *
 * Returns null if fewer than 2 usable close prices exist.
 */
function computeMetrics(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return null;

  const closes = prices
    .map(p => (p.adjClose != null ? p.adjClose : p.close))
    .filter(v => v != null && v > 0);

  if (closes.length < 2) return null;

  const oldest = closes[0];
  const latest = closes[closes.length - 1];

  const nav = latest;

  // Momentum score
  const momentumPct = (latest - oldest) / oldest;
  const momentum = clamp(5 + momentumPct * 50, 1, 10);

  // Daily returns
  const dailyReturns = [];
  for (let i = 1; i < closes.length; i++) {
    dailyReturns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const std = sampleStdDev(dailyReturns);
  const sharpeRaw = std > 0 ? (avgReturn / std) * Math.sqrt(252) : 0;
  const riskAdj = clamp(5 + sharpeRaw * 2, 1, 10);

  return {
    nav,
    momentum: Number(momentum.toFixed(4)),
    sharpe:   Number(sharpeRaw.toFixed(4)),
    riskAdj:  Number(riskAdj.toFixed(4)),
  };
}

/**
 * Attempts to read stale (possibly expired) tiingo_cache rows directly.
 * Called only after a 429 response, so we want anything we have, regardless
 * of age. Returns { nav, momentum, sharpe, riskAdj } or null.
 */
async function getStaleCache(ticker) {
  try {
    const rows = await supaFetch(
      `tiingo_cache?ticker=eq.${encodeURIComponent(ticker.toUpperCase())}`
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    return {
      nav:      row.nav      ?? null,
      momentum: row.momentum ?? 5.0,
      sharpe:   row.sharpe   ?? 0,
      riskAdj:  row.risk_adj ?? 5.0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Fetches price metrics for all given tickers.
 *
 * @param {string[]}  tickers    - Array of fund ticker strings.
 * @param {Function}  onProgress - Optional callback(completedCount, totalCount).
 *                                 Called after every 3rd ticker completes.
 * @returns {Promise<Object>}    - { TICKER: { nav, momentum, sharpe, riskAdj } }
 */
export async function fetchTiingoMetrics(tickers, onProgress) {
  const results = {};
  let completed = 0;

  // ── Batch cache check (single round-trip) ────────────────────────────────
  let freshCache = {};
  try {
    freshCache = await getTiingoCache(tickers);
  } catch (err) {
    console.warn('[tiingo] cache read error:', err.message);
  }

  // ── Per-ticker loop ───────────────────────────────────────────────────────
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];

    // Money market funds — fixed fallback, no scoring needed
    if (MONEY_MARKET_TICKERS.has(ticker)) {
      results[ticker] = { nav: null, momentum: 5.0, sharpe: 0, riskAdj: 5.0 };
      completed++;
      if (completed % 3 === 0 && onProgress) onProgress(completed, tickers.length);
      continue;
    }

    // Fresh cache hit
    if (freshCache[ticker]) {
      results[ticker] = freshCache[ticker];
      completed++;
      if (completed % 3 === 0 && onProgress) onProgress(completed, tickers.length);
      continue;
    }

    // ── Live Tiingo fetch ─────────────────────────────────────────────────
    const startDate = isoDateAgo(63);
    const endDate   = isoDateAgo(0);
    const url = `/api/tiingo/tiingo/daily/${encodeURIComponent(ticker)}/prices?startDate=${startDate}&endDate=${endDate}`;

    let metrics = null;

    try {
      const res = await fetch(url);

      if (res.status === 429) {
        // Rate-limited — try stale cache before giving up
        console.warn(`[tiingo] 429 for ${ticker} — attempting stale cache`);
        const stale = await getStaleCache(ticker);
        if (stale) {
          console.warn(`[tiingo] ${ticker} using stale cache due to 429`);
          metrics = stale;
        } else {
          console.warn(`[tiingo] ${ticker} no stale cache — using fallback 5.0`);
        }
      } else if (res.ok) {
        const prices = await res.json();
        metrics = computeMetrics(prices);

        if (!metrics) {
          console.warn(`[tiingo] ${ticker} insufficient price data — using fallback 5.0`);
        }
      } else {
        console.warn(`[tiingo] ${ticker} HTTP ${res.status} — using fallback 5.0`);
      }
    } catch (err) {
      console.warn(`[tiingo] ${ticker} fetch error:`, err.message);
    }

    // Persist fresh metrics to cache; skip on stale passthrough (already stored)
    if (metrics && metrics !== null) {
      results[ticker] = metrics;
      // Only write to cache if this came from a live fetch (nav is numeric)
      if (metrics.nav != null) {
        try {
          await saveTiingoCache(ticker, metrics);
        } catch (cacheErr) {
          console.warn(`[tiingo] ${ticker} cache save error:`, cacheErr.message);
        }
      }
    } else {
      // Emit 5.0 fallback — pipeline.js will set dataQuality flag
      results[ticker] = { nav: null, momentum: 5.0, sharpe: 0, riskAdj: 5.0 };
    }

    completed++;
    if (completed % 3 === 0 && onProgress) onProgress(completed, tickers.length);

    // 200ms spacing — Tiingo free tier
    if (i < tickers.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Final progress tick if last batch didn't land on a multiple of 3
  if (onProgress && completed > 0 && completed % 3 !== 0) {
    onProgress(completed, tickers.length);
  }

  return results;
}
