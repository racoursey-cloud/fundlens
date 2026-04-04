// src/engine/cusip.js
// Resolves CUSIPs to equity tickers via OpenFIGI API with Supabase caching.
//
// Pipeline integration: called by quality.js BEFORE Finnhub lookups.
// For each fund's holdings that have a CUSIP but no ticker, resolves the
// CUSIP to a ticker via cache-first OpenFIGI lookup. Mutates holding
// objects in place so all downstream code (quality.js, classify.js) benefits
// automatically with zero interface changes.
//
// OpenFIGI free tier (no API key): 5 requests/minute, 10 CUSIPs per request.
// Sequential batch processing with 13s delays between batches.
// Scoped to top 30 holdings per fund by weight (quality.js only scores top 15).
//
// A15 Phase 2: Also detects fund-of-funds holdings (securityType2 indicates a
// mutual fund) and sets h._is_underlying_fund = true for look-through scoring
// in quality.js.
//
// ⚠️  No localStorage. No direct Supabase calls.
// ⚠️  Sequential API calls with 6.5s delays between batches. Never Promise.all().
// ⚠️  All API calls route through /api/openfigi proxy (server.js injects CORS).
// ⚠️  Cache "not found" CUSIPs too — avoids re-querying bonds/private placements.

import { apiFetch } from '../services/api.js';
import { getCusipCache, saveCusipCache } from '../services/cache.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE       = 10;    // OpenFIGI free tier (no API key): max 10 per request
const BATCH_DELAY_MS   = 13000; // 13s between batches (safe under 5 req/min no-key limit)
const RETRY_DELAY_MS   = 30000; // 30s wait on 429 before retry
const MAX_RETRIES      = 1;     // 1 retry max per batch
const TOP_N_PER_FUND   = 30;    // Only resolve top holdings by weight per fund

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Builds a CUSIP → holdings[] index across all funds.
 * Only includes holdings that have a CUSIP but no ticker.
 *
 * @param {Object} holdingsMap — { FUND_TICKER: { holdings: [...], meta } }
 * @returns {{ cusipIndex: Map<string, Array>, uniqueCusips: string[] }}
 */
function buildCusipIndex(holdingsMap) {
  const cusipIndex = new Map(); // cusip → [holding, holding, ...]

  for (const fundTicker of Object.keys(holdingsMap)) {
    const holdings = holdingsMap[fundTicker]?.holdings ?? [];

    // Only resolve top holdings by weight — quality.js scores top 15 equities,
    // so top 30 gives headroom after filtering out bonds/unknowns.
    const topHoldings = [...holdings]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, TOP_N_PER_FUND);

    for (const h of topHoldings) {
      const cusip = (h.cusip || '').trim();
      if (!cusip) continue;                    // no CUSIP available
      if (h.holding_ticker) continue;          // already has a ticker

      if (!cusipIndex.has(cusip)) {
        cusipIndex.set(cusip, []);
      }
      cusipIndex.get(cusip).push(h);
    }
  }

  return {
    cusipIndex,
    uniqueCusips: [...cusipIndex.keys()],
  };
}

/**
 * Applies a resolved CUSIP result to all holdings sharing that CUSIP.
 * Mutates holdings in place.
 *
 * A15 Phase 2: Also detects fund-of-funds holdings via securityType2.
 * OpenFIGI returns securityType2 values like "Open-End Fund", "Mutual Fund",
 * "Closed-End Fund" for fund holdings. When detected, sets
 * h._is_underlying_fund = true so quality.js can apply look-through scoring.
 *
 * @param {Map}    cusipIndex — cusip → [holding, ...]
 * @param {string} cusip
 * @param {Object} result — { ticker, name, security_type, market_sector }
 */
function applyResolution(cusipIndex, cusip, result) {
  const holdings = cusipIndex.get(cusip);
  if (!holdings) return;

  for (const h of holdings) {
    if (result.ticker) {
      h.holding_ticker = result.ticker;
    }
    // Always set resolved security type (even for bonds/unknowns)
    // so isEquityHolding() can classify correctly
    h._resolved_security_type = result.security_type || null;
    h._resolved_market_sector = result.market_sector || null;

    // A15 Phase 2: Detect fund holdings for look-through scoring.
    // OpenFIGI securityType2 values for funds:
    //   "Open-End Fund"   — mutual funds (most common)
    //   "Mutual Fund"     — alternative label
    //   "Closed-End Fund" — CEFs
    // We do NOT flag ETFs ("ETP") — Finnhub covers ETF components directly.
    const secType = (result.security_type || '').toLowerCase();
    if (secType.includes('open-end fund') ||
        secType.includes('mutual fund') ||
        secType.includes('closed-end fund')) {
      h._is_underlying_fund = true;
    }
  }
}

/**
 * Sends a batch of CUSIPs to OpenFIGI and returns parsed results.
 * Handles 429 with a single retry after RETRY_DELAY_MS.
 *
 * @param {string[]} cusipBatch — up to 100 CUSIPs
 * @returns {Promise<Array>} — parallel array of { ticker, name, security_type, market_sector, figi } or null
 */
async function fetchOpenFigiBatch(cusipBatch) {
  const body = cusipBatch.map(cusip => ({
    idType:  'ID_CUSIP',
    idValue: cusip,
  }));

  let retries = 0;

  while (retries <= MAX_RETRIES) {
    try {
      const data = await apiFetch('/api/openfigi/v3/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Response is an array parallel to the request array.
      // Each element has either { data: [...] } or { warning: "..." }.
      if (!Array.isArray(data)) {
        console.warn('[cusip] OpenFIGI returned non-array response:', typeof data);
        return cusipBatch.map(() => null);
      }

      return data.map((item, i) => {
        if (item.warning) {
          // CUSIP not found — bond, private placement, etc.
          return {
            cusip:         cusipBatch[i],
            ticker:        null,
            name:          null,
            security_type: 'not_found',
            market_sector: null,
            figi:          null,
          };
        }

        if (item.data && item.data.length > 0) {
          // Pick the first result (most common match).
          // Prefer US-listed if multiple results exist.
          const match = item.data.find(d => d.exchCode === 'US')
                     || item.data[0];

          return {
            cusip:         cusipBatch[i],
            ticker:        match.ticker || null,
            name:          match.name   || null,
            security_type: match.securityType2 || null,
            market_sector: match.marketSector  || null,
            figi:          match.figi          || null,
          };
        }

        return {
          cusip:         cusipBatch[i],
          ticker:        null,
          name:          null,
          security_type: 'not_found',
          market_sector: null,
          figi:          null,
        };
      });
    } catch (err) {
      // Check for 429 rate limit
      if (err.message && err.message.includes('429') && retries < MAX_RETRIES) {
        console.warn(`[cusip] OpenFIGI 429 — waiting ${RETRY_DELAY_MS / 1000}s before retry`);
        await sleep(RETRY_DELAY_MS);
        retries++;
        continue;
      }

      // Non-retryable error — log and return nulls so pipeline continues
      console.warn(`[cusip] OpenFIGI batch error:`, err.message);
      return cusipBatch.map(() => null);
    }
  }

  // Should not reach here, but safety fallback
  return cusipBatch.map(() => null);
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Resolves CUSIPs to tickers for holdings across all funds.
 * Mutates holding objects in place: sets h.holding_ticker when resolved.
 * Also sets h._resolved_security_type for downstream use by isEquityHolding().
 * A15 Phase 2: Sets h._is_underlying_fund for fund-of-funds look-through.
 *
 * @param {Object} holdingsMap — { TICKER: { holdings: [...], meta } }
 * @param {Function} [onProgress] — Optional callback(completed, total)
 * @returns {Promise<{ resolved: number, cached: number, apiCalls: number, notFound: number }>}
 */
export async function resolveCusipTickers(holdingsMap, onProgress) {
  const stats = { resolved: 0, cached: 0, apiCalls: 0, notFound: 0 };

  if (!holdingsMap || typeof holdingsMap !== 'object') return stats;

  const startTime = Date.now();

  // ── Step 1: Build CUSIP index ──────────────────────────────────────────
  const { cusipIndex, uniqueCusips } = buildCusipIndex(holdingsMap);

  if (uniqueCusips.length === 0) {
    console.log('[cusip] No CUSIPs need resolution (all holdings have tickers)');
    return stats;
  }

  console.log(`[cusip] ${uniqueCusips.length} unique CUSIPs need resolution across ${cusipIndex.size} holdings`);

  // ── Step 2: Batch cache lookup ─────────────────────────────────────────
  let cacheMap = {};
  try {
    cacheMap = await getCusipCache(uniqueCusips);
    const cacheHits = Object.keys(cacheMap).length;
    console.log(`[cusip] Cache: ${cacheHits}/${uniqueCusips.length} CUSIPs cached`);
  } catch (err) {
    console.warn('[cusip] Cache lookup failed, all CUSIPs will use API:', err.message);
  }

  // ── Step 3: Apply cache hits ───────────────────────────────────────────
  const cacheMisses = [];

  for (const cusip of uniqueCusips) {
    const cached = cacheMap[cusip];
    if (cached) {
      applyResolution(cusipIndex, cusip, cached);
      stats.cached++;
      if (cached.ticker) {
        stats.resolved++;
      } else {
        stats.notFound++;
      }
    } else {
      cacheMisses.push(cusip);
    }
  }

  if (cacheMisses.length === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[cusip] Resolved ${stats.resolved}/${uniqueCusips.length} CUSIPs ` +
      `(${stats.cached} cached, 0 API calls, ${stats.notFound} not found) in ${elapsed}s`);
    return stats;
  }

  console.log(`[cusip] ${cacheMisses.length} cache misses — querying OpenFIGI`);

  // ── Step 4: Batch OpenFIGI requests ────────────────────────────────────
  const totalBatches = Math.ceil(cacheMisses.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchStart = batchIdx * BATCH_SIZE;
    const batchCusips = cacheMisses.slice(batchStart, batchStart + BATCH_SIZE);

    console.log(`[cusip] OpenFIGI batch ${batchIdx + 1}/${totalBatches} — ${batchCusips.length} CUSIPs`);
    stats.apiCalls++;

    const results = await fetchOpenFigiBatch(batchCusips);

    // ── Step 4a: Process results and save to cache ─────────────────────
    const toCache = [];

    for (let i = 0; i < batchCusips.length; i++) {
      const cusip = batchCusips[i];
      const result = results[i];

      if (!result) continue; // API error for this item

      // Apply to holdings in place
      applyResolution(cusipIndex, cusip, result);

      if (result.ticker) {
        stats.resolved++;
      } else {
        stats.notFound++;
      }

      // Queue for cache save (including "not found" to avoid re-queries)
      toCache.push({
        cusip:         result.cusip,
        ticker:        result.ticker,
        name:          result.name,
        security_type: result.security_type,
        market_sector: result.market_sector,
        figi:          result.figi,
      });
    }

    // Persist to Supabase cache (non-blocking, but we await to stay sequential)
    if (toCache.length > 0) {
      try {
        await saveCusipCache(toCache);
      } catch (err) {
        console.warn('[cusip] Cache save failed for batch:', err.message);
      }
    }

    // Report progress
    if (onProgress) {
      onProgress(batchIdx + 1, totalBatches);
    }

    // ── Step 4b: Rate limit delay ──────────────────────────────────────
    if (batchIdx < totalBatches - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // ── Step 5: Log summary ────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[cusip] Resolved ${stats.resolved}/${uniqueCusips.length} CUSIPs ` +
    `(${stats.cached} cached, ${stats.apiCalls} API calls, ${stats.notFound} not found) in ${elapsed}s`);

  return stats;
}
