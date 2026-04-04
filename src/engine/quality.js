// src/engine/quality.js
// Holdings quality scoring engine for FundLens v5.1 (Assignment A4).
//
// Pipeline step 6 input: holdings from edgar.js (enriched by classify.js),
// plus Finnhub fundamentals for top equity holdings.
//
// Two scoring paths by holding type:
//   Equity  → Piotroski-lite (5 binary checks on Finnhub fundamentals)
//   Bond    → issuerCat quality map (A2 finding: no letter-grade ratings in NPORT-P)
//   Blended → weighted average by equity/bond portfolio share
//
// Returns { score, coverage_pct, equity_ratio, bond_ratio, details } per fund.
//
// scoring.js (A6) consumes coverage_pct to decide weight adjustment:
//   if coverage_pct < 0.40 → quality weight halved, redistributed to sector alignment
//
// Extensibility: Finnhub calls can be swapped for a richer fundamentals provider
// (FMP, EODHD, etc.) without changing the return interface.
//
// ⚠️  No localStorage. No direct Supabase calls.
// ⚠️  Finnhub has rate limits (~60/min free tier). Calls are sequential with 300ms delays.

import { apiFetch } from '../services/api.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TOP_N_EQUITY      = 15;    // top equity holdings by weight for Finnhub lookup
const FINNHUB_DELAY_MS  = 300;   // delay between Finnhub API calls
const FINNHUB_TIMEOUT   = 8000;  // per-call timeout (ms)

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
 * Determines if a holding is equity (vs bond/debt/other).
 * Uses is_debt flag from edgar.js, plus asset_type as fallback.
 */
function isEquityHolding(holding) {
  // Explicit debt flag from NPORT debtSec element
  if (holding.is_debt === true) return false;

  // Asset type classification from NPORT assetCat
  const at = (holding.asset_type || '').toUpperCase();
  if (at === 'EC' || at === 'EP') return true;  // equity common, equity preferred
  if (at === 'DBT' || at === 'ABS' || at === 'STIV') return false; // debt, ABS, short-term

  // If no explicit markers, treat as equity if it has a ticker and no debt flag
  if (holding.holding_ticker && !holding.is_debt) return true;

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

/**
 * Piotroski-lite: 5 binary pass/fail checks on Finnhub metrics.
 * Returns { points, available } — score = points / available.
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

// ---------------------------------------------------------------------------
// Per-fund quality scoring
// ---------------------------------------------------------------------------

/**
 * Computes holdings quality score for a single fund.
 *
 * @param {Array} holdings - Holdings array from edgar.js (enriched by classify.js)
 * @returns {Promise<Object>} - { score, coverage_pct, equity_ratio, bond_ratio, details }
 */
async function scoreFundQuality(holdings) {
  const result = {
    score:        5.0,    // fallback
    coverage_pct: 0,
    equity_ratio: 0,
    bond_ratio:   0,
    details: {
      equityScore:    null,
      bondScore:      null,
      equityCount:    0,
      bondCount:      0,
      finnhubHits:    0,
      finnhubMisses:  0,
    },
  };

  if (!holdings || holdings.length === 0) return result;

  // ── Separate equity vs bond holdings ────────────────────────────────────
  const equities = [];
  const bonds    = [];

  for (const h of holdings) {
    if (isEquityHolding(h)) {
      equities.push(h);
    } else if (h.is_debt || ['DBT', 'ABS'].includes((h.asset_type || '').toUpperCase())) {
      bonds.push(h);
    }
    // Other types (STIV, RF, derivatives) are excluded from quality scoring
  }

  const totalWeight = holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
  const equityWeight = equities.reduce((sum, h) => sum + (h.weight ?? 0), 0);
  const bondWeight   = bonds.reduce((sum, h) => sum + (h.weight ?? 0), 0);

  result.equity_ratio = totalWeight > 0 ? equityWeight / totalWeight : 0;
  result.bond_ratio   = totalWeight > 0 ? bondWeight / totalWeight : 0;
  result.details.equityCount = equities.length;
  result.details.bondCount   = bonds.length;

  // ── Equity scoring: Piotroski-lite on top 15 by weight ──────────────────
  let equityScaledScore = null;
  let equityCoverageWeight = 0;

  if (equities.length > 0) {
    // Sort by weight descending, take top 15
    const topEquities = [...equities]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, TOP_N_EQUITY);

    const topTotalWeight = topEquities.reduce((s, h) => s + (h.weight ?? 0), 0);
    let weightedQualitySum = 0;
    let scoredWeight = 0;

    for (let i = 0; i < topEquities.length; i++) {
      const h = topEquities[i];
      const ticker = (h.holding_ticker || '').replace(/[^A-Z]/gi, '').toUpperCase();

      if (!ticker) {
        result.details.finnhubMisses++;
        continue;
      }

      const metrics = await fetchFinnhubMetrics(ticker);

      if (!metrics) {
        result.details.finnhubMisses++;
      } else {
        const { points, available } = piotroskiLite(metrics);

        if (available > 0) {
          const holdingQuality = points / available; // 0 to 1
          weightedQualitySum += holdingQuality * (h.weight ?? 0);
          scoredWeight += (h.weight ?? 0);
          result.details.finnhubHits++;
        } else {
          result.details.finnhubMisses++;
        }
      }

      // Delay between Finnhub calls to respect rate limits
      if (i < topEquities.length - 1) {
        await sleep(FINNHUB_DELAY_MS);
      }
    }

    if (scoredWeight > 0) {
      const equityQuality = weightedQualitySum / scoredWeight; // 0 to 1
      equityScaledScore = 1 + 9 * equityQuality; // 1 to 10
      equityCoverageWeight = scoredWeight;
    }

    result.details.equityScore = equityScaledScore;
  }

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
  // Equity coverage: weight of holdings with Finnhub data / total equity weight
  // Bond coverage: all bonds are scored (issuerCat always produces a value) = 100%
  const equityCoverage = equityWeight > 0 ? equityCoverageWeight / equityWeight : 0;
  const bondCoverage   = bondWeight > 0 ? 1.0 : 0; // bonds always have issuerCat score

  // Overall coverage weighted by equity/bond ratio
  if (totalWeight > 0) {
    result.coverage_pct = (equityCoverage * equityWeight + bondCoverage * bondWeight)
                        / (equityWeight + bondWeight || 1);
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
          equityCount: 0, bondCount: 0,
          finnhubHits: 0, finnhubMisses: 0,
        },
      };
    } else {
      console.log(`[quality] scoring ${ticker} — ${holdings.length} holdings`);
      results[ticker] = await scoreFundQuality(holdings);
      console.log(`[quality] ${ticker} → score=${results[ticker].score.toFixed(2)}, ` +
        `coverage=${(results[ticker].coverage_pct * 100).toFixed(0)}%, ` +
        `eq=${results[ticker].details.finnhubHits}/${results[ticker].details.finnhubHits + results[ticker].details.finnhubMisses} Finnhub hits`);
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
