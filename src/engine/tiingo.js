// src/engine/tiingo.js
// Fetches 63-day price data from Tiingo for all fund tickers and returns
// raw returns + daily returns arrays. Scoring (cross-sectional Z-score + CDF)
// happens in scoring.js, which needs ALL funds' returns simultaneously.
//
// Return shape per ticker:
//   { nav, rawReturn, dailyReturns }
//     nav          — latest adjusted close (number or null)
//     rawReturn    — (latest − oldest) / oldest over 63-day window (number or null)
//     dailyReturns — array of day-over-day fractional returns ([] if unavailable)
//
// Cache: Supabase tiingo_cache (1-day TTL) via cache.js helpers.
//   Existing columns repurposed until A10 renames them:
//     nav      → nav (unchanged)
//     momentum → rawReturn (same numeric type)
//     raw_data → dailyReturns JSON array
//     sharpe / risk_adj → null (no longer computed)
//
// ⚠️  All Supabase calls route through supaFetch() in cache.js.
// ⚠️  No localStorage. No direct Supabase calls.
// ⚠️  200ms delay between live Tiingo fetches (free-tier rate limit).
// ⚠️  429 handling: serve stale cache if available, else emit null fallbacks.

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

/**
 * Returns a YYYY-MM-DD date string for `daysBack` days in the past.
 */
function isoDateAgo(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

/**
 * Extracts { nav, rawReturn, dailyReturns } from a Tiingo prices array.
 *
 * Tiingo returns rows oldest-first when queried with startDate/endDate.
 * Each row may have adjClose or close; adjClose is preferred.
 *
 * rawReturn = (latest_close − oldest_close) / oldest_close   (63-day window)
 * dailyReturns = array of day-over-day fractional changes
 *
 * Returns null if fewer than 2 usable close prices exist.
 */
function extractReturns(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return null;

  const closes = prices
    .map(p => (p.adjClose != null ? p.adjClose : p.close))
    .filter(v => v != null && v > 0);

  if (closes.length < 2) return null;

  const oldest = closes[0];
  const latest = closes[closes.length - 1];

  const nav = latest;
  const rawReturn = (latest - oldest) / oldest;

  const dailyReturns = [];
  for (let i = 1; i < closes.length; i++) {
    dailyReturns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  return {
    nav:          Number(nav.toFixed(4)),
    rawReturn:    Number(rawReturn.toFixed(6)),
    dailyReturns,
  };
}

/**
 * Reads a cache row returned by getTiingoCache and maps the existing
 * column names to the new return shape.
 *
 * Cache columns (legacy names kept until A10):
 *   momentum → rawReturn
 *   raw_data → dailyReturns (parsed from JSON)
 *   nav      → nav
 */
function cacheRowToResult(row) {
  return {
    nav:          row.nav          ?? null,
    rawReturn:    row.momentum     ?? null,   // A5: rawReturn stored in momentum column
    dailyReturns: Array.isArray(row.riskAdj)  // won't be an array — rawData is the right field
      ? row.riskAdj
      : (Array.isArray(row.rawData) ? row.rawData : []),
  };
}

/**
 * Attempts to read stale (possibly expired) tiingo_cache rows directly.
 * Called only after a 429 response, so we want anything we have, regardless
 * of age. Returns { nav, rawReturn, dailyReturns } or null.
 */
async function getStaleCache(ticker) {
  try {
    const rows = await supaFetch(
      `tiingo_cache?ticker=eq.${encodeURIComponent(ticker.toUpperCase())}`
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];

    // Parse raw_data if it's a JSON string containing dailyReturns
    let dailyReturns = [];
    if (row.raw_data) {
      try {
        const parsed = typeof row.raw_data === 'string'
          ? JSON.parse(row.raw_data)
          : row.raw_data;
        if (Array.isArray(parsed)) dailyReturns = parsed;
      } catch { /* ignore parse errors */ }
    }

    return {
      nav:          row.nav      ?? null,
      rawReturn:    row.momentum ?? null,
      dailyReturns,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Fetches raw price return data for all given tickers.
 *
 * @param {string[]}  tickers    - Array of fund ticker strings.
 * @param {Function}  onProgress - Optional callback(completedCount, totalCount).
 *                                 Called after every 3rd ticker completes.
 * @returns {Promise<Object>}    - { TICKER: { nav, rawReturn, dailyReturns } }
 *
 * Downstream usage (scoring.js A6):
 *   rawReturn feeds into cross-sectional Z-score + normal CDF → momentum score
 *   dailyReturns available for volatility calculations if needed
 *   nav displayed in UI
 *
 * Fallback when data unavailable:
 *   { nav: null, rawReturn: null, dailyReturns: [] }
 *   scoring.js will assign momentum = 5.0 and set a dataQuality flag
 */
export async function fetchTiingoMetrics(tickers, onProgress) {
  const results = {};
  let completed = 0;

  // ── Null fallback (used when data is unavailable) ────────────────────────
  const nullResult = { nav: null, rawReturn: null, dailyReturns: [] };

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

    // Money market funds — no price data needed
    if (MONEY_MARKET_TICKERS.has(ticker)) {
      results[ticker] = { ...nullResult };
      completed++;
      if (completed % 3 === 0 && onProgress) onProgress(completed, tickers.length);
      continue;
    }

    // Fresh cache hit — map legacy column names to new shape
    if (freshCache[ticker]) {
      const cached = freshCache[ticker];

      // Parse dailyReturns from the rawData field (stored in raw_data column)
      let dailyReturns = [];
      if (cached.rawData) {
        try {
          const parsed = typeof cached.rawData === 'string'
            ? JSON.parse(cached.rawData)
            : cached.rawData;
          if (Array.isArray(parsed)) dailyReturns = parsed;
        } catch { /* ignore */ }
      }

      results[ticker] = {
        nav:          cached.nav      ?? null,
        rawReturn:    cached.momentum ?? null,   // rawReturn stored in momentum column
        dailyReturns,
      };
      completed++;
      if (completed % 3 === 0 && onProgress) onProgress(completed, tickers.length);
      continue;
    }

    // ── Live Tiingo fetch ─────────────────────────────────────────────────
    const startDate = isoDateAgo(63);
    const endDate   = isoDateAgo(0);
    const url = `/api/tiingo/tiingo/daily/${encodeURIComponent(ticker)}/prices?startDate=${startDate}&endDate=${endDate}`;

    let data = null;

    try {
      const res = await fetch(url);

      if (res.status === 429) {
        // Rate-limited — try stale cache before giving up
        console.warn(`[tiingo] 429 for ${ticker} — attempting stale cache`);
        const stale = await getStaleCache(ticker);
        if (stale) {
          console.warn(`[tiingo] ${ticker} using stale cache due to 429`);
          results[ticker] = stale;
        } else {
          console.warn(`[tiingo] ${ticker} no stale cache — using null fallback`);
          results[ticker] = { ...nullResult };
        }
        completed++;
        if (completed % 3 === 0 && onProgress) onProgress(completed, tickers.length);
        if (i < tickers.length - 1) await sleep(DELAY_MS);
        continue;
      }

      if (res.ok) {
        const prices = await res.json();
        data = extractReturns(prices);

        if (!data) {
          console.warn(`[tiingo] ${ticker} insufficient price data — using null fallback`);
        }
      } else {
        console.warn(`[tiingo] ${ticker} HTTP ${res.status} — using null fallback`);
      }
    } catch (err) {
      console.warn(`[tiingo] ${ticker} fetch error:`, err.message);
    }

    if (data) {
      results[ticker] = data;

      // Persist to cache — repurpose existing columns:
      //   nav      → nav
      //   momentum → rawReturn
      //   raw_data → dailyReturns (JSON array)
      //   sharpe / riskAdj → null
      try {
        await saveTiingoCache(ticker, {
          nav:      data.nav,
          momentum: data.rawReturn,
          sharpe:   null,
          riskAdj:  null,
          rawData:  data.dailyReturns,
        });
      } catch (cacheErr) {
        console.warn(`[tiingo] ${ticker} cache save error:`, cacheErr.message);
      }
    } else {
      results[ticker] = { ...nullResult };
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
