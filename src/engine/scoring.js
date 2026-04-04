// =============================================================================
// FundLens v5.1 — src/engine/scoring.js
// Composite score calculator — 3-factor model + modifiers.
//
// Factors:
//   sectorAlignment  (40%)  — fund sector weights × thesis sector scores
//   momentum         (30%)  — cross-sectional Z-score + normal CDF (MSCI)
//   holdingsQuality  (30%)  — Piotroski-lite equity + issuerCat bonds (quality.js)
//
// Composite:
//   composite = (sectorAlignment × W1) + (momentum × W2) + (holdingsQuality × W3)
//               − concentrationPenalty
//               + expenseModifier
//               + flowModifier
//               + turnoverModifier (0.0 — deferred)
//               clamped 1.0 – 10.0
//
// Null sub-scores → 5.0 fallback + dataQuality flag
// Money market (FDRXX, ADAXX) → fixed 5.0, all calculation skipped
// =============================================================================

import {
  MONEY_MARKET_TICKERS,
  EXPENSE_THRESHOLDS,
  FLOW_MODIFIER,
  CONCENTRATION,
} from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Abramowitz & Stegun approximation to the standard normal CDF Φ(x).
 * Maximum error ≈ 7.5 × 10⁻⁸.
 *
 * @param {number} x
 * @returns {number} Φ(x) in [0, 1]
 */
function normalCDF(x) {
  if (x < -8) return 0;
  if (x >  8) return 1;

  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  const y = 1.0 - (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5)
            * Math.exp(-0.5 * absX * absX);

  return 0.5 * (1.0 + sign * y);
}

// ---------------------------------------------------------------------------
// Factor 1: Sector Alignment
// ---------------------------------------------------------------------------

/**
 * sectorAlignment = Σ(fund_sector_weight × thesis_sector_score) / Σ(fund_sector_weight)
 * Only holdings with non-null .sector participate.
 *
 * @param {Array}  holdings    — [{ sector, weight, ... }]
 * @param {Object} sectorScores — { 'Technology': 7.2, 'Financials': 4.5, ... }
 * @returns {{ score: number, breakdown: Object, hasSectorData: boolean }}
 */
function computeSectorAlignment(holdings, sectorScores) {
  if (!Array.isArray(holdings) || holdings.length === 0 || !sectorScores) {
    return { score: null, breakdown: {}, hasSectorData: false };
  }

  // Aggregate raw weights by sector (only classified holdings)
  const sectorWeights = {};
  let totalWeight = 0;

  for (const h of holdings) {
    if (!h.sector) continue;               // unclassified → skip
    const w = Number(h.weight) || 0;
    if (w <= 0) continue;
    sectorWeights[h.sector] = (sectorWeights[h.sector] ?? 0) + w;
    totalWeight += w;
  }

  if (totalWeight === 0) {
    return { score: null, breakdown: {}, hasSectorData: false };
  }

  // Weighted average of thesis scores
  let weightedSum = 0;

  for (const [sector, weight] of Object.entries(sectorWeights)) {
    const thesisScore = Number(sectorScores[sector]);
    // If thesis has no score for this sector, treat as neutral 5.0
    const score = Number.isFinite(thesisScore) ? thesisScore : 5.0;
    weightedSum += weight * score;
  }

  const alignment = weightedSum / totalWeight;

  // Build percentage breakdown for downstream use (outlier.js, UI)
  const breakdown = {};
  for (const [sec, w] of Object.entries(sectorWeights)) {
    breakdown[sec] = parseFloat(((w / totalWeight) * 100).toFixed(2));
  }

  return {
    score: parseFloat(clamp(alignment, 1.0, 10.0).toFixed(3)),
    breakdown,
    hasSectorData: true,
  };
}

// ---------------------------------------------------------------------------
// Factor 2: Momentum (cross-sectional Z-score)
// ---------------------------------------------------------------------------

/**
 * Computes momentum scores for ALL funds simultaneously.
 *   1. Collect rawReturn from tiingoData for each fund
 *   2. Vol-scale: divide rawReturn by realized volatility (dailyReturns)
 *      to remove systematic bias toward volatile funds (Barroso & Santa-Clara 2015)
 *   3. Compute mean and sample stdev across all vol-scaled returns
 *   4. z = (volScaledReturn − mean) / stdev, winsorized to [−3, 3]
 *   5. momentum = 1 + 9 × Φ(z)   (continuous 1–10 S-curve)
 *
 * Vol-scaling ensures that a 10% return at 25% vol is not ranked higher than
 * a 4% return at 5% vol. Funds with insufficient daily data (< 10 observations)
 * fall back to raw return for the cross-sectional ranking.
 *
 * Funds with null rawReturn get momentum = null (caller applies 5.0 fallback).
 *
 * @param {Array}  tickers    — ['FXAIX', 'PRPFX', ...]
 * @param {Object} tiingoData — { TICKER: { nav, rawReturn, dailyReturns } }
 * @returns {Object} { TICKER: number | null }
 */
function computeCrossSectionalMomentum(tickers, tiingoData) {
  const result = {};

  // Step 1: collect vol-scaled returns
  const validReturns = [];
  const returnByTicker = {};

  for (const ticker of tickers) {
    const data = tiingoData?.[ticker];
    const raw  = data?.rawReturn;

    if (raw == null || !Number.isFinite(Number(raw))) {
      returnByTicker[ticker] = null;
      continue;
    }

    let val = Number(raw);

    // Vol-scale: rawReturn / realized period vol
    // Requires ≥ 10 daily returns for a meaningful vol estimate
    const dr = data?.dailyReturns;
    if (Array.isArray(dr) && dr.length >= 10) {
      const drMean = dr.reduce((a, b) => a + b, 0) / dr.length;
      const drVar  = dr.reduce((acc, v) => acc + (v - drMean) ** 2, 0)
                     / (dr.length - 1);
      const dailyVol = Math.sqrt(drVar);

      if (dailyVol > 0) {
        const periodVol = dailyVol * Math.sqrt(dr.length);
        val = raw / periodVol;   // risk-adjusted return (Sharpe-like)
      }
    }

    validReturns.push(val);
    returnByTicker[ticker] = val;
  }

  // If fewer than 2 valid returns, can't compute meaningful Z-scores
  if (validReturns.length < 2) {
    for (const ticker of tickers) {
      result[ticker] = null;
    }
    return result;
  }

  // Step 2: mean and sample stdev (Bessel-corrected, N−1)
  const mean = validReturns.reduce((a, b) => a + b, 0) / validReturns.length;
  const variance = validReturns.reduce((acc, v) => acc + (v - mean) ** 2, 0)
                   / (validReturns.length - 1);
  const stdev = Math.sqrt(variance);

  // Guard against zero stdev (all returns identical)
  if (stdev === 0) {
    for (const ticker of tickers) {
      result[ticker] = returnByTicker[ticker] != null ? 5.0 : null;
    }
    return result;
  }

  // Step 3–4: Z-score → winsorize → CDF → 1–10 scale
  for (const ticker of tickers) {
    const raw = returnByTicker[ticker];
    if (raw == null) {
      result[ticker] = null;
      continue;
    }

    const z = (raw - mean) / stdev;
    const zWinsorized = clamp(z, -3, 3);
    const momentum = 1 + 9 * normalCDF(zWinsorized);
    result[ticker] = parseFloat(momentum.toFixed(3));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Concentration Penalty
// ---------------------------------------------------------------------------

/**
 * HHI-based concentration penalty, scaled by risk tolerance.
 *   HHI = Σ(sector_share²)
 *   penalty = max(0, (HHI − hhiBaseline) × scalingFactor)
 *   risk_multiplier = riskBase − (risk_tolerance − 1) × riskStep
 *   final = penalty × risk_multiplier
 *
 * @param {Object} sectorBreakdown — { 'Technology': 45.2, 'Financials': 22.1, ... } (percentages)
 * @param {number} riskTolerance   — 1–9 slider value
 * @returns {number} penalty in 0–2 range
 */
function computeConcentrationPenalty(sectorBreakdown, riskTolerance) {
  if (!sectorBreakdown || Object.keys(sectorBreakdown).length === 0) {
    return 0;
  }

  const hhi = Object.values(sectorBreakdown)
    .reduce((acc, pct) => acc + (pct / 100) ** 2, 0);

  const rawPenalty = Math.max(0, (hhi - CONCENTRATION.hhiBaseline) * CONCENTRATION.scalingFactor);
  const rt = clamp(Number(riskTolerance) || 5, 1, 9);
  const riskMultiplier = CONCENTRATION.riskBase - (rt - 1) * CONCENTRATION.riskStep;

  return parseFloat((rawPenalty * riskMultiplier).toFixed(4));
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Expense modifier: net < 0.005 → +0.5 | net > 0.012 → −0.5 | else 0.0
 */
function computeExpenseModifier(expenseRatios, ticker) {
  const expData = expenseRatios?.[ticker];
  if (!expData || expData.net == null) return 0;

  const net = Number(expData.net);
  if (net < EXPENSE_THRESHOLDS.lowCutoff)  return EXPENSE_THRESHOLDS.bonus;
  if (net > EXPENSE_THRESHOLDS.highCutoff) return EXPENSE_THRESHOLDS.penalty;
  return 0;
}

/**
 * Flow modifier: netFlows > 0 → +0.2 | netFlows < 0 → −0.2 | unavailable → 0.0
 */
function computeFlowModifier(edgarMeta, ticker) {
  const meta = edgarMeta?.[ticker];
  if (!meta || meta.netFlows == null) return 0;

  const flows = Number(meta.netFlows);
  if (flows > 0) return FLOW_MODIFIER.inflow;
  if (flows < 0) return FLOW_MODIFIER.outflow;
  return 0;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Calculates composite scores for all funds using the 3-factor model.
 *
 * @param {Array}  funds          — [{ ticker, name }, ...]
 * @param {Object} tiingoData     — { TICKER: { nav, rawReturn, dailyReturns } }
 * @param {Object} qualityScores  — { TICKER: { score, coverage_pct, equity_ratio, bond_ratio, details } }
 * @param {Object} expenseRatios  — { TICKER: { gross, net, note } }
 * @param {Object} holdingsMap    — { TICKER: [{ sector, weight, ... }] }
 * @param {Object} sectorScores   — { 'Technology': 7.2, ... } from thesis
 * @param {Object} edgarMeta      — { TICKER: { totalAssets, netAssets, netFlows, reportDate } }
 * @param {Object} weights        — { sectorAlignment, momentum, holdingsQuality, risk_tolerance }
 * @returns {Array} Scored fund objects sorted by composite descending
 */
export function calcCompositeScores(
  funds,
  tiingoData,
  qualityScores,
  expenseRatios,
  holdingsMap,
  sectorScores,
  edgarMeta,
  weights
) {
  // ── Identify non-money-market tickers for cross-sectional momentum ───────
  const scorableTickers = funds
    .map(f => (f.ticker || '').toUpperCase())
    .filter(t => !MONEY_MARKET_TICKERS.has(t));

  // ── Compute momentum for all scorable funds at once ──────────────────────
  const momentumScores = computeCrossSectionalMomentum(scorableTickers, tiingoData);

  // ── Score each fund ──────────────────────────────────────────────────────
  const results = [];

  for (const fund of funds) {
    const ticker = (fund.ticker || '').toUpperCase();

    // ── Money Market — fixed 5.0, skip all calculation ─────────────────────
    if (MONEY_MARKET_TICKERS.has(ticker)) {
      results.push({
        ...fund,
        ticker,
        composite:            5.0,
        sectorAlignment:      5.0,
        momentum:             5.0,
        holdingsQuality:      5.0,
        concentrationPenalty: 0,
        expenseModifier:      0,
        flowModifier:         0,
        turnoverModifier:     0,
        sectorBreakdown:      {},
        isMoneyMarket:        true,
        dataQuality: {
          sectorAlignmentFallback:  false,
          momentumFallback:         false,
          holdingsQualityFallback:  false,
          qualityWeightHalved:      false,
          fallbackCount:            0,
        },
      });
      continue;
    }

    // ── Factor 1: Sector Alignment ─────────────────────────────────────────
    const holdings = holdingsMap?.[ticker];
    const sectorResult = computeSectorAlignment(holdings, sectorScores);
    const sectorAlignmentFallback = sectorResult.score == null;
    const sectorAlignmentScore = sectorAlignmentFallback ? 5.0 : sectorResult.score;
    const sectorBreakdown = sectorResult.breakdown;

    // ── Factor 2: Momentum (already computed cross-sectionally) ────────────
    const momentumRaw = momentumScores[ticker] ?? null;
    const momentumFallback = momentumRaw == null;
    const momentumScore = momentumFallback ? 5.0 : momentumRaw;

    // ── Factor 3: Holdings Quality ─────────────────────────────────────────
    const qualityData = qualityScores?.[ticker];
    const qualityRaw = qualityData?.score ?? null;
    const holdingsQualityFallback = qualityRaw == null;
    const holdingsQualityScore = holdingsQualityFallback ? 5.0 : Number(qualityRaw);

    // Coverage-based weight adjustment:
    // If coverage_pct < 0.40, halve quality weight, add freed weight to sector alignment
    const coveragePct = qualityData?.coverage_pct ?? 0;
    const qualityWeightHalved = !holdingsQualityFallback && coveragePct < 0.40;

    // ── Normalize weights (per-fund, accounts for quality weight halving) ──
    const rawW1 = Number(weights?.sectorAlignment)  || 40;
    const rawW2 = Number(weights?.momentum)          || 30;
    const rawW3 = Number(weights?.holdingsQuality)   || 30;

    let adjW1 = rawW1;
    let adjW2 = rawW2;
    let adjW3 = rawW3;

    if (qualityWeightHalved) {
      const freed = adjW3 / 2;
      adjW3 = adjW3 - freed;
      adjW1 = adjW1 + freed;        // freed weight goes to sector alignment
    }

    const wSum = adjW1 + adjW2 + adjW3 || 1;
    const W1 = adjW1 / wSum;
    const W2 = adjW2 / wSum;
    const W3 = adjW3 / wSum;

    // ── Data quality tracking ──────────────────────────────────────────────
    const fallbackCount = [sectorAlignmentFallback, momentumFallback, holdingsQualityFallback]
      .filter(Boolean).length;

    const dataQuality = {
      sectorAlignmentFallback,
      momentumFallback,
      holdingsQualityFallback,
      qualityWeightHalved,
      fallbackCount,
    };

    // ── Concentration Penalty ──────────────────────────────────────────────
    const rt = Number(weights?.risk_tolerance) || 5;
    const concentrationPenalty = computeConcentrationPenalty(sectorBreakdown, rt);

    // ── Modifiers ──────────────────────────────────────────────────────────
    const expenseModifier  = computeExpenseModifier(expenseRatios, ticker);
    const flowModifier     = computeFlowModifier(edgarMeta, ticker);
    const turnoverModifier = 0.0;   // deferred — turnover not in NPORT-P

    // ── Composite formula ──────────────────────────────────────────────────
    const weighted =
      sectorAlignmentScore * W1 +
      momentumScore        * W2 +
      holdingsQualityScore * W3;

    const composite = clamp(
      weighted - concentrationPenalty + expenseModifier + flowModifier + turnoverModifier,
      1.0,
      10.0
    );

    results.push({
      ...fund,
      ticker,
      composite:            parseFloat(composite.toFixed(3)),
      sectorAlignment:      parseFloat(sectorAlignmentScore.toFixed(3)),
      momentum:             parseFloat(momentumScore.toFixed(3)),
      holdingsQuality:      parseFloat(holdingsQualityScore.toFixed(3)),
      concentrationPenalty,
      expenseModifier,
      flowModifier,
      turnoverModifier,
      sectorBreakdown,
      isMoneyMarket:        false,
      dataQuality,
    });
  }

  // Sort by composite descending
  return results.sort((a, b) => b.composite - a.composite);
}
