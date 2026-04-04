// src/engine/quality.js
// Holdings quality scoring engine for FundLens v5.1 (Assignment A4, A13, A15).
//
// Pipeline step 6 input: holdings from edgar.js (enriched by classify.js),
// plus fundamentals for top equity holdings from Finnhub (primary) and
// FMP (fallback — A15).
//
// A13: Before scoring, resolves CUSIPs to tickers via cusip.js for holdings
// that lack tickers (Fidelity, Vanguard, Allspring, etc.). This enables
// fundamentals lookups for ~45% of funds that were previously scoring 5.0 fallback.
//
// A15 Phase 1: Added FMP (Financial Modeling Prep) as a fallback fundamentals
// provider. When Finnhub returns no data for a ticker (403, empty metrics, or
// rate limit), quality.js now tries FMP before counting the holding as a miss.
//
// A15 Phase 2: Fund-of-funds look-through scoring. When a holding IS a mutual
// fund (detected via NPORT asset_type "RF" or OpenFIGI securityType2), quality.js:
//   1. Fetches that fund's NPORT-P holdings from EDGAR
//   2. Recursively scores those holdings via Piotroski-lite (depth limit = 1)
//   3. Uses the resulting score as the holding-level quality score
// This closes Gap 2: WFPRX, WEGRX holding other mutual funds (EVSRX, EKSRX,
// EQIRX, EMGDX) — neither Finnhub nor FMP serves fundamentals for mutual funds.
//
// Three scoring paths by holding type:
//   Equity      → Piotroski-lite (5 binary checks on fundamentals)
//   Bond        → issuerCat quality map (A2 finding: no letter-grade ratings in NPORT-P)
//   Fund-of-fund → Look-through: fetch underlying holdings, score recursively
//   Blended     → weighted average by equity/bond/fund portfolio share
//
// Returns { score, coverage_pct, equity_ratio, bond_ratio, details } per fund.
//
// scoring.js (A6) consumes coverage_pct to decide weight adjustment:
//   if coverage_pct < 0.40 → quality weight halved, redistributed to sector alignment
//
// ⚠️  No localStorage. No direct Supabase calls.
// ⚠️  Finnhub has rate limits (~60/min free tier). Calls are sequential with 300ms delays.
// ⚠️  FMP has rate limits (~250/day free tier). Calls are sequential with 300ms delays.
// ⚠️  Both providers' metrics are cached in Supabase (7-day TTL).
//     First run populates the cache; subsequent runs serve from cache.
//     Shared holdings across funds (e.g. AAPL in 5 funds) hit the API once.

import { apiFetch } from '../services/api.js';
import { getFinnhubCache, saveFinnhubCache, getFmpCache, saveFmpCache } from '../services/cache.js';
import { resolveCusipTickers } from './cusip.js';
import { fetchSingleFundHoldings } from './edgar.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOP_N_EQUITY         = 15;   // top equity holdings by weight for fundamentals lookup
const LOOKTHROUGH_TOP_N    = 10;   // top fund-of-funds holdings for look-through scoring (A15 Phase 2)
const FINNHUB_DELAY_MS     = 300;  // delay between Finnhub API calls
const FMP_DELAY_MS         = 300;  // delay between FMP API calls
const FINNHUB_TIMEOUT      = 8000; // per-call timeout (ms)
const LOOKTHROUGH_DELAY_MS = 300;  // delay between look-through EDGAR fetches

// ---------------------------------------------------------------------------
// Bond quality map — issuerCat proxies (A2 finding, plan lines 188–199)
// Per-holding credit ratings (AAA/BBB/etc) are NOT in NPORT-P XML.
// These proxies use issuerCat + isDefault + fairValLevel instead.
// ---------------------------------------------------------------------------

const ISSUER_CAT_QUALITY = {
  'UST':        1.0,    // US Treasury → AAA equivalent
  'USG':        0.95,   // US Government agency → AA equivalent
  'MUN':        0.8,    // Municipal → A equivalent
  'CORP':       0.6,    // Corporate (no distress) → BBB equivalent
};

// Fallback for unrecognized issuerCat values
const ISSUER_CAT_DEFAULT = 0.5;

/**
 * Scores a single bond holding using issuerCat, isDefault, and fairValLevel.
 * Returns a 0–1 quality score.
 */
function scoreBondHolding(holding) {
  const cat = (holding.issuer_cat || '').toUpperCase().trim();

  // Distressed: isDefault = 'Y'
  if (holding.debt_is_default === 'Y') return 0.1;

  // Corporate with Level 3 fair value or interest in arrears → below investment grade
  if (cat === 'CORP' || cat === 'CORPORATE' || cat === '') {
    const fairVal = String(holding.fair_val_level || '').trim();
    if (fairVal === '3' || holding.debt_in_arrears === 'Y') return 0.35;
  }

  // Look up issuerCat in quality map
  // Normalize common variants
  const normalized = cat
    .replace(/^US\s*TREASURY$/i, 'UST')
    .replace(/^US\s*GOVERNMENT$/i, 'USG')
    .replace(/^MUNICIPAL$/i, 'MUN')
    .replace(/^CORPORATE$/i, 'CORP');

  return ISSUER_CAT_QUALITY[normalized] ?? ISSUER_CAT_DEFAULT;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines if a holding is equity (vs bond/debt/fund/other).
 * Uses is_debt flag from edgar.js, plus asset_type as fallback.
 */
function isEquityHolding(holding) {
  // Explicit debt flag from NPORT debtSec element
  if (holding.is_debt === true) return false;

  // Asset type classification from NPORT assetCat
  const at = (holding.asset_type || '').toUpperCase();
  if (at === 'EC' || at === 'EP') return true;  // equity common, equity preferred
  if (at === 'DBT' || at === 'ABS' || at === 'STIV') return false; // debt, ABS, short-term
  if (at === 'RF') return false; // registered fund — handled by isFundHolding, not equity

  // A13: OpenFIGI-resolved security type (set by cusip.js)
  const resolved = (holding._resolved_security_type || '').toLowerCase();
  if (resolved.includes('common stock') || resolved.includes('preferred')) return true;
  if (resolved.includes('bond') || resolved.includes('note') || resolved.includes('bill')) return false;

  // If no explicit markers, treat as equity if it has a ticker and no debt flag
  if (holding.holding_ticker && !holding.is_debt) return true;

  return false;
}

/**
 * Determines if a holding is a mutual fund (for look-through scoring).
 * Checks two signals:
 *   1. NPORT asset_type "RF" (registered fund) — set by EDGAR XML parser
 *   2. _is_underlying_fund flag — set by cusip.js via OpenFIGI securityType2
 *
 * A15 Phase 2: Must be checked BEFORE isEquityHolding() in the classification
 * loop, because fund holdings with tickers would otherwise pass the fallback
 * equity test (has ticker + no debt flag → true).
 */
function isFundHolding(holding) {
  // Flag set by cusip.js from OpenFIGI securityType2
  if (holding._is_underlying_fund === true) return true;

  // NPORT assetCat = RF (registered fund)
  const at = (holding.asset_type || '').toUpperCase();
  if (at === 'RF') return true;

  // OpenFIGI-resolved security type (for CUSIPs that went through resolution)
  const resolved = (holding._resolved_security_type || '').toLowerCase();
  if (resolved.includes('open-end fund') ||
      resolved.includes('mutual fund') ||
      resolved.includes('closed-end fund')) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Finnhub fundamentals fetch
// ---------------------------------------------------------------------------

/**
 * Fetches financial metrics for a single equity ticker from Finnhub.
 * Endpoint: /api/finnhub/stock/metric?symbol={ticker}&metric=all
 *
 * Returns the metric object or null on failure.
 */
async function fetchFinnhubMetrics(ticker) {
  try {
    const data = await apiFetch(
      `/api/finnhub/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all`
    );
    return data?.metric ?? null;
  } catch (err) {
    // 404, 429, or network errors are non-fatal — holding gets no score
    console.warn(`[quality] Finnhub error for ${ticker}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FMP fundamentals fetch — A15
// ---------------------------------------------------------------------------

/**
 * Fetches financial metrics for a single equity ticker from FMP.
 * Endpoint: /api/fmp/stable/ratios?symbol={ticker}&period=annual
 *
 * FMP's stable API returns an array of annual ratio objects (newest first).
 * We take the first element and normalize field names to match Finnhub's
 * naming so piotroskiLite() works unchanged.
 *
 * FMP stable/ratios fields used:
 *   netProfitMargin              → netProfitMarginTTM
 *   debtToEquityRatio            → totalDebtToEquityQuarterly
 *   freeCashFlowPerShare         → freeCashFlowTTM (sign is what Piotroski checks)
 *   netIncomePerShare / bookValuePerShare → roeTTM (derived DuPont-style)
 *   revenuePerShare (current vs prior yr) → revenueGrowthTTMYoy (derived)
 *
 * Returns a Finnhub-compatible metrics object or null on failure.
 */
async function fetchFmpMetrics(ticker) {
  try {
    const data = await apiFetch(
      `/api/fmp/stable/ratios?symbol=${encodeURIComponent(ticker)}&period=annual`
    );

    // FMP returns an array of annual periods — take first (most recent)
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw || typeof raw !== 'object') return null;

    // Check for FMP error responses (e.g. { "Error Message": "..." })
    if (raw['Error Message']) return null;

    // Derive ROE from net income per share / book value per share
    let derivedROE = null;
    if (raw.netIncomePerShare != null && raw.bookValuePerShare != null && raw.bookValuePerShare !== 0) {
      derivedROE = raw.netIncomePerShare / raw.bookValuePerShare;
    }

    // Derive revenue growth from current vs prior year
    let derivedRevGrowth = null;
    if (Array.isArray(data) && data.length >= 2) {
      const currRev = data[0]?.revenuePerShare;
      const prevRev = data[1]?.revenuePerShare;
      if (currRev != null && prevRev != null && prevRev !== 0) {
        derivedRevGrowth = (currRev - prevRev) / Math.abs(prevRev);
      }
    }

    // Normalize to Finnhub-compatible field names for piotroskiLite()
    const metrics = {
      // ROE: derived from NI/BV
      roeTTM: derivedROE,

      // Profit margin: direct field
      netProfitMarginTTM: raw.netProfitMargin ?? null,

      // Debt-to-equity: direct field
      totalDebtToEquityQuarterly: raw.debtToEquityRatio ?? null,

      // Revenue growth: derived from YoY revenue per share
      revenueGrowthTTMYoy: derivedRevGrowth,

      // Free cash flow: per-share is fine — sign is what Piotroski checks
      freeCashFlowTTM: raw.freeCashFlowPerShare ?? null,
    };

    // Only return if we got at least one usable metric
    const hasData = Object.values(metrics).some(v => v != null);
    return hasData ? metrics : null;
  } catch (err) {
    console.warn(`[quality] FMP error for ${ticker}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Piotroski-lite scoring
// ---------------------------------------------------------------------------

/**
 * Piotroski-lite: 5 binary pass/fail checks on fundamentals metrics.
 * Returns { points, available } — score = points / available.
 *
 * Works with both Finnhub and FMP data (A15) because FMP metrics are
 * normalized to the same field names.
 *
 * Checks (plan lines 173–178):
 *   +1 if ROE > 0
 *   +1 if profit margin > 0
 *   +1 if debt/equity < 1.0
 *   +1 if revenue growth > 0
 *   +1 if free cash flow > 0 (if available)
 */
function piotroskiLite(metrics) {
  let points = 0;
  let available = 0;

  // ROE (return on equity)
  const roe = metrics.roeTTM ?? metrics.roeRfy ?? null;
  if (roe != null) {
    available++;
    if (roe > 0) points++;
  }

  // Profit margin (net margin)
  const margin = metrics.netProfitMarginTTM ?? metrics.netProfitMarginAnnual ?? null;
  if (margin != null) {
    available++;
    if (margin > 0) points++;
  }

  // Debt-to-equity
  const de = metrics.totalDebtToEquityQuarterly ?? metrics.totalDebtToEquityAnnual ?? null;
  if (de != null) {
    available++;
    if (de < 1.0) points++;
  }

  // Revenue growth
  const revGrowth = metrics.revenueGrowthTTMYoy ?? metrics.revenueGrowth3Y ?? null;
  if (revGrowth != null) {
    available++;
    if (revGrowth > 0) points++;
  }

  // Cash flow (Piotroski: CFO > 0)
  // currentRatioQuarterly is a liquidity ratio, not a cash flow measure — removed.
  // Free cash flow is the closest available proxy from Finnhub free tier.
  const fcf = metrics.freeCashFlowTTM ?? metrics.freeCashFlowPerShareTTM ?? null;
  if (fcf != null) {
    available++;
    if (fcf > 0) points++;
  }

  return { points, available };
}

/**
 * Checks whether a metrics object has at least one field that piotroskiLite
 * can actually use. Finnhub sometimes returns a valid response with an empty
 * metric object (e.g. for international or small-cap stocks). That empty
 * object gets cached as non-null, which would prevent the FMP fallback from
 * firing. This function catches that case.
 */
function hasUsableMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return false;
  // Check every field that piotroskiLite reads
  return (
    metrics.roeTTM != null ||
    metrics.roeRfy != null ||
    metrics.netProfitMarginTTM != null ||
    metrics.netProfitMarginAnnual != null ||
    metrics.totalDebtToEquityQuarterly != null ||
    metrics.totalDebtToEquityAnnual != null ||
    metrics.revenueGrowthTTMYoy != null ||
    metrics.revenueGrowth3Y != null ||
    metrics.freeCashFlowTTM != null ||
    metrics.freeCashFlowPerShareTTM != null
  );
}

// ---------------------------------------------------------------------------
// Per-fund quality scoring
// ---------------------------------------------------------------------------

/**
 * Computes holdings quality score for a single fund.
 *
 * A15 Phase 2: Added depth parameter for look-through recursion control.
 *   depth 0 = top-level fund (look-through enabled for fund holdings)
 *   depth 1 = underlying fund (look-through disabled — prevents runaway recursion)
 *
 * @param {Array}  holdings        - Holdings array from edgar.js (enriched by classify.js)
 * @param {Object} metricsCache    - Shared Finnhub cache map { TICKER: metricsObject }, mutated in place
 * @param {Object} fmpMetricsCache - Shared FMP cache map { TICKER: metricsObject }, mutated in place (A15)
 * @param {number} [depth=0]       - Recursion depth (A15 Phase 2). 0 = allow look-through, 1 = stop.
 * @returns {Promise<Object>} - { score, coverage_pct, equity_ratio, bond_ratio, details }
 */
async function scoreFundQuality(holdings, metricsCache, fmpMetricsCache, depth = 0) {
  const result = {
    score:        5.0,    // fallback
    coverage_pct: 0,
    equity_ratio: 0,
    bond_ratio:   0,
    details: {
      equityScore:      null,
      bondScore:        null,
      equityCount:      0,
      bondCount:        0,
      fundHoldingCount: 0,      // A15 Phase 2: underlying fund holdings detected
      finnhubHits:      0,
      fmpHits:          0,      // A15: holdings scored via FMP fallback
      lookThroughHits:  0,      // A15 Phase 2: holdings scored via look-through
      totalMisses:      0,      // A15: holdings with no data from any provider
    },
  };

  if (!holdings || holdings.length === 0) return result;

  // ── Separate equity vs bond vs fund holdings ───────────────────────────
  // A15 Phase 2: Check isFundHolding() FIRST — fund holdings with tickers
  // would otherwise pass isEquityHolding()'s fallback test.
  const equities     = [];
  const bonds        = [];
  const fundHoldings = [];

  for (const h of holdings) {
    if (isFundHolding(h)) {
      fundHoldings.push(h);
    } else if (isEquityHolding(h)) {
      equities.push(h);
    } else if (h.is_debt || ['DBT', 'ABS'].includes((h.asset_type || '').toUpperCase())) {
      bonds.push(h);
    }
    // Other types (STIV, derivatives) are excluded from quality scoring
  }

  const totalWeight  = holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
  const equityWeight = equities.reduce((sum, h) => sum + (h.weight ?? 0), 0);
  const bondWeight   = bonds.reduce((sum, h) => sum + (h.weight ?? 0), 0);
  const fundWeight   = fundHoldings.reduce((sum, h) => sum + (h.weight ?? 0), 0);

  // Fund holdings are equity-like for ratio calculation (they hold equities internally)
  result.equity_ratio = totalWeight > 0 ? (equityWeight + fundWeight) / totalWeight : 0;
  result.bond_ratio   = totalWeight > 0 ? bondWeight / totalWeight : 0;
  result.details.equityCount      = equities.length;
  result.details.bondCount        = bonds.length;
  result.details.fundHoldingCount = fundHoldings.length;

  // ── Equity + Fund scoring: shared weighted average ─────────────────────
  // Equity holdings scored via Piotroski-lite, fund holdings scored via
  // look-through. Both contribute to the same weighted quality sum.
  let equityScaledScore = null;
  let equityCoverageWeight = 0;

  // Hoisted accumulators so both equity and fund scoring contribute
  let weightedQualitySum = 0;
  let scoredWeight = 0;

  // ── Equity scoring: Piotroski-lite on top 15 by weight ────────────────
  if (equities.length > 0) {
    // Sort by weight descending, take top 15
    const topEquities = [...equities]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, TOP_N_EQUITY);

    for (let i = 0; i < topEquities.length; i++) {
      const h = topEquities[i];
      const ticker = (h.holding_ticker || '').replace(/[^A-Z]/gi, '').toUpperCase();

      if (!ticker) {
        result.details.totalMisses++;
        continue;
      }

      // ── Step 1: Try Finnhub (cache → API) ────────────────────────────
      let metrics = metricsCache[ticker] ?? null;
      let fromFinnhubCache = metrics != null;

      if (!fromFinnhubCache) {
        metrics = await fetchFinnhubMetrics(ticker);

        if (metrics) {
          // Save to local map (avoids repeat API calls for shared holdings
          // across funds in this run) and persist to Supabase (7-day TTL).
          metricsCache[ticker] = metrics;
          saveFinnhubCache(ticker, metrics).catch(err =>
            console.warn(`[quality] Finnhub cache save failed for ${ticker}:`, err.message)
          );
        }

        // Delay only after actual API calls, not cache hits
        if (i < topEquities.length - 1) {
          await sleep(FINNHUB_DELAY_MS);
        }
      }

      // ── Step 2: If Finnhub missed or returned empty metrics, try FMP ──
      // A15: Closes gaps for international equities and small-cap stocks.
      // Finnhub often returns a valid response with an empty metric object
      // for non-US or small-cap tickers. hasUsableMetrics() catches this so
      // the FMP fallback actually fires instead of silently scoring 0.
      let usedFmp = false;
      if (!metrics || !hasUsableMetrics(metrics)) {
        metrics = null; // reset so FMP result replaces the empty Finnhub object
        metrics = fmpMetricsCache[ticker] ?? null;
        let fromFmpCache = metrics != null;

        if (!fromFmpCache) {
          metrics = await fetchFmpMetrics(ticker);

          if (metrics) {
            fmpMetricsCache[ticker] = metrics;
            saveFmpCache(ticker, metrics).catch(err =>
              console.warn(`[quality] FMP cache save failed for ${ticker}:`, err.message)
            );
          }

          // Delay only after actual API calls
          if (i < topEquities.length - 1) {
            await sleep(FMP_DELAY_MS);
          }
        }

        usedFmp = true;
      }

      // ── Step 3: Score the holding ────────────────────────────────────
      if (!metrics) {
        result.details.totalMisses++;
      } else {
        const { points, available } = piotroskiLite(metrics);

        if (available > 0) {
          const holdingQuality = points / available; // 0 to 1
          weightedQualitySum += holdingQuality * (h.weight ?? 0);
          scoredWeight += (h.weight ?? 0);

          if (usedFmp) {
            result.details.fmpHits++;
          } else {
            result.details.finnhubHits++;
          }
        } else {
          result.details.totalMisses++;
        }
      }
    }
  }

  // ── Fund-of-funds look-through scoring (A15 Phase 2) ──────────────────
  // Only at depth 0 (top-level funds). Depth 1 = underlying fund → no further
  // look-through. If the underlying fund also holds funds, those score 5.0.
  if (fundHoldings.length > 0 && depth === 0) {
    const topFunds = [...fundHoldings]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, LOOKTHROUGH_TOP_N);

    console.log(`[quality] Look-through: ${topFunds.length} fund holdings to score ` +
      `(${fundHoldings.length} total, top ${LOOKTHROUGH_TOP_N})`);

    for (let i = 0; i < topFunds.length; i++) {
      const h = topFunds[i];
      const ticker = (h.holding_ticker || '').replace(/[^A-Z]/gi, '').toUpperCase();

      if (!ticker) {
        result.details.totalMisses++;
        continue;
      }

      console.log(`[quality] Look-through: fetching ${ticker} holdings (weight=${(h.weight ?? 0).toFixed(2)}%)`);

      try {
        // Fetch underlying fund's NPORT-P holdings from EDGAR
        const { holdings: underlyingHoldings } = await fetchSingleFundHoldings(ticker);

        if (!underlyingHoldings || underlyingHoldings.length === 0) {
          console.warn(`[quality] Look-through: ${ticker} — no holdings found`);
          result.details.totalMisses++;
          continue;
        }

        console.log(`[quality] Look-through: ${ticker} — ${underlyingHoldings.length} holdings, scoring...`);

        // Score the underlying fund recursively (depth = 1 prevents further look-through)
        // Pass shared caches so overlapping equities (AAPL across multiple underlying
        // funds) hit Finnhub/FMP only once.
        const underlyingResult = await scoreFundQuality(
          underlyingHoldings, metricsCache, fmpMetricsCache, depth + 1
        );

        // Accept the score if it moved from fallback OR has any coverage
        if (underlyingResult.score !== 5.0 || underlyingResult.coverage_pct > 0) {
          // Convert 1–10 scaled score back to 0–1 quality for weighted average
          const holdingQuality = (underlyingResult.score - 1) / 9;
          weightedQualitySum += holdingQuality * (h.weight ?? 0);
          scoredWeight += (h.weight ?? 0);
          result.details.lookThroughHits++;

          console.log(`[quality] Look-through: ${ticker} → score=${underlyingResult.score.toFixed(2)}, ` +
            `coverage=${(underlyingResult.coverage_pct * 100).toFixed(0)}%, ` +
            `equity=${underlyingResult.details.equityCount}, bond=${underlyingResult.details.bondCount}`);
        } else {
          console.warn(`[quality] Look-through: ${ticker} — scored 5.0 with 0% coverage, counting as miss`);
          result.details.totalMisses++;
        }
      } catch (err) {
        console.warn(`[quality] Look-through error for ${ticker}:`, err.message);
        result.details.totalMisses++;
      }

      // Rate limit between look-through fetches
      if (i < topFunds.length - 1) {
        await sleep(LOOKTHROUGH_DELAY_MS);
      }
    }
  }

  // ── Compute blended equity-like score (equities + fund look-throughs) ──
  if (scoredWeight > 0) {
    const equityQuality = weightedQualitySum / scoredWeight; // 0 to 1
    equityScaledScore = 1 + 9 * equityQuality; // 1 to 10
    equityCoverageWeight = scoredWeight;
  }

  result.details.equityScore = equityScaledScore;

  // ── Bond scoring: issuerCat quality map ─────────────────────────────────
  let bondScaledScore = null;

  if (bonds.length > 0) {
    let weightedBondQuality = 0;
    let bondScoredWeight = 0;

    for (const h of bonds) {
      const quality = scoreBondHolding(h);
      weightedBondQuality += quality * (h.weight ?? 0);
      bondScoredWeight += (h.weight ?? 0);
    }

    if (bondScoredWeight > 0) {
      const bondQuality = weightedBondQuality / bondScoredWeight; // 0 to 1
      bondScaledScore = 1 + 9 * bondQuality; // 1 to 10
    }

    result.details.bondScore = bondScaledScore;
  }

  // ── Blended score (plan lines 201–206) ──────────────────────────────────
  // equity_ratio now includes fund holding weight (they're equity-like)
  if (equityScaledScore != null && bondScaledScore != null) {
    // Both paths have data — blend by portfolio share
    result.score = (equityScaledScore * result.equity_ratio)
                 + (bondScaledScore * result.bond_ratio);
  } else if (equityScaledScore != null) {
    result.score = equityScaledScore;
  } else if (bondScaledScore != null) {
    result.score = bondScaledScore;
  }
  // else: stays at 5.0 fallback

  // ── Coverage percentage (plan lines 183, 208–211) ───────────────────────
  // Equity coverage: weight of scored holdings / total equity-like weight
  // (includes fund look-through weight in both numerator and denominator)
  // Bond coverage: all bonds are scored (issuerCat always produces a value) = 100%
  const totalEquityLikeWeight = equityWeight + fundWeight;
  const equityCoverage = totalEquityLikeWeight > 0 ? equityCoverageWeight / totalEquityLikeWeight : 0;
  const bondCoverage   = bondWeight > 0 ? 1.0 : 0; // bonds always have issuerCat score

  // Overall coverage weighted by equity/bond ratio
  if (totalWeight > 0) {
    result.coverage_pct = (equityCoverage * totalEquityLikeWeight + bondCoverage * bondWeight)
                        / (totalEquityLikeWeight + bondWeight || 1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Computes holdings quality scores for all funds.
 *
 * Pipeline step 6. Sits between fetchHoldingsFundamentals (step 6 in pipeline)
 * and expense analysis (step 7). Called by scoring.js (A6) or pipeline.js (A9).
 *
 * @param {Object} holdingsMap - edgar.js output: { TICKER: { holdings: [...], meta } }
 * @param {Function} [onProgress] - Optional callback(completed, total)
 * @returns {Promise<Object>} - { TICKER: { score, coverage_pct, equity_ratio, bond_ratio, details } }
 */
export async function computeHoldingsQuality(holdingsMap, onProgress) {
  const results = {};

  if (!holdingsMap || typeof holdingsMap !== 'object') return results;

  const tickers = Object.keys(holdingsMap);

  // ── A13: Pre-step — Resolve CUSIPs to tickers for holdings missing tickers ─
  // Must run BEFORE the equity ticker collection below so that newly-resolved
  // tickers are included in the cache pre-population and scoring.
  try {
    const cusipResult = await resolveCusipTickers(holdingsMap);
    console.log(`[quality] CUSIP resolution: ${cusipResult.resolved} tickers resolved ` +
      `(${cusipResult.cached} cached, ${cusipResult.apiCalls} API calls, ` +
      `${cusipResult.notFound} not found)`);
  } catch (err) {
    console.warn('[quality] CUSIP resolution failed, continuing with available tickers:', err.message);
  }

  // ── Pre-populate caches from Supabase ──────────────────────────────────
  // Collect all unique equity tickers across all funds' top-15 holdings,
  // batch-fetch from Supabase (7-day TTL), then only call APIs for cache
  // misses. Shared holdings across funds (AAPL, MSFT, etc.) only hit
  // the API once per 7-day window.
  const allEquityTickers = new Set();

  for (const fundTicker of tickers) {
    const holdings = holdingsMap[fundTicker]?.holdings ?? [];
    const equities = holdings
      .filter(h => isEquityHolding(h) && !isFundHolding(h))
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, TOP_N_EQUITY);

    for (const h of equities) {
      const t = (h.holding_ticker || '').replace(/[^A-Z]/gi, '').toUpperCase();
      if (t) allEquityTickers.add(t);
    }
  }

  // Batch-fetch Finnhub cache from Supabase (single query for all tickers)
  let metricsCache = {};
  if (allEquityTickers.size > 0) {
    try {
      metricsCache = await getFinnhubCache([...allEquityTickers]);
      const cacheHits = Object.keys(metricsCache).length;
      console.log(`[quality] Finnhub cache: ${cacheHits}/${allEquityTickers.size} holdings cached, ${allEquityTickers.size - cacheHits} need API calls`);
    } catch (err) {
      console.warn('[quality] Finnhub cache fetch failed, all holdings will use API:', err.message);
    }
  }

  // A15: Batch-fetch FMP cache from Supabase (same ticker set)
  // FMP cache is populated by previous runs where Finnhub missed. Pre-fetching
  // avoids redundant FMP API calls for tickers already resolved via FMP.
  let fmpMetricsCache = {};
  if (allEquityTickers.size > 0) {
    try {
      fmpMetricsCache = await getFmpCache([...allEquityTickers]);
      const fmpCacheHits = Object.keys(fmpMetricsCache).length;
      if (fmpCacheHits > 0) {
        console.log(`[quality] FMP cache: ${fmpCacheHits} holdings pre-cached`);
      }
    } catch (err) {
      console.warn('[quality] FMP cache fetch failed:', err.message);
    }
  }

  // ── Score each fund ────────────────────────────────────────────────────────
  let completed = 0;

  for (const ticker of tickers) {
    const entry = holdingsMap[ticker];
    const holdings = entry?.holdings ?? [];

    if (holdings.length === 0) {
      results[ticker] = {
        score:        5.0,
        coverage_pct: 0,
        equity_ratio: 0,
        bond_ratio:   0,
        details: {
          equityScore: null, bondScore: null,
          equityCount: 0, bondCount: 0, fundHoldingCount: 0,
          finnhubHits: 0, fmpHits: 0, lookThroughHits: 0, totalMisses: 0,
        },
      };
    } else {
      console.log(`[quality] scoring ${ticker} — ${holdings.length} holdings`);
      results[ticker] = await scoreFundQuality(holdings, metricsCache, fmpMetricsCache);

      const d = results[ticker].details;
      const totalScored = d.finnhubHits + d.fmpHits + d.lookThroughHits;
      const totalAttempted = totalScored + d.totalMisses;

      console.log(`[quality] ${ticker} → score=${results[ticker].score.toFixed(2)}, ` +
        `coverage=${(results[ticker].coverage_pct * 100).toFixed(0)}%, ` +
        `hits=${totalScored}/${totalAttempted} ` +
        `(finnhub=${d.finnhubHits}, fmp=${d.fmpHits}, lookThrough=${d.lookThroughHits}, miss=${d.totalMisses})`);
    }

    completed++;
    if (onProgress && completed % 3 === 0) {
      onProgress(completed, tickers.length);
    }
  }

  // Final progress tick
  if (onProgress && completed > 0 && completed % 3 !== 0) {
    onProgress(completed, tickers.length);
  }

  return results;
}
