// =============================================================================
// FundLens v5.1 — src/engine/outlier.js
// Modified Z-Score outlier detection + exponential allocation engine.
//
// Steps:
//   1. Modified Z-Score on composite scores (money market excluded)
//      Quality gates: below-median (modZ < 0) or low-data (≥4 fallbacks) → 0%
//   2. Exponential allocation: k = 0.1 + (riskTolerance × 0.20), weight = e^(k × Z)
//   3. 30% per-fund hard cap with proportional redistribution
//   4. Capture threshold: walk ranked allocations until cumulative weight
//      hits a risk-scaled target, trim the tail, re-normalize to 100%
//   5. Round to 1 decimal, absorb rounding error into largest holding
//
// No Claude calls. No external API calls. Pure math.
// Concentration penalty is already applied in scoring.js — not recalculated here.
// =============================================================================

import { ALLOCATION_LIMITS, MONEY_MARKET_TICKERS, getTierFromModZ } from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Clamp risk tolerance to the valid 1–9 slider range. */
function clampRisk(rt) {
  if (!Number.isFinite(rt)) return 5;
  return Math.min(9, Math.max(1, rt));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Computes allocation percentages from scored funds.
 *
 * @param {Array}  scoredFunds   - Sorted array from scoring.js calcCompositeScores()
 *   Each: { ticker, name, composite, sectorAlignment, momentum, holdingsQuality,
 *           concentrationPenalty, expenseModifier, flowModifier, turnoverModifier,
 *           sectorBreakdown, isMoneyMarket, dataQuality }
 *   dataQuality: { sectorAlignmentFallback, momentumFallback, holdingsQualityFallback,
 *                  qualityWeightHalved, fallbackCount }
 *
 * @param {number} riskTolerance - Investment Style slider value 1–9
 *
 * @returns {Array} Objects with { ticker, allocation_pct (0–1), tier (string), modZ, composite }
 *   Sorted by allocation_pct descending. Non-allocated funds appear with allocation_pct = 0.
 */
export function computeAllocations(scoredFunds, riskTolerance) {
  if (!Array.isArray(scoredFunds) || scoredFunds.length === 0) return [];

  // ── STEP 1 — Modified Z-Score ─────────────────────────────────────────────
  // Pool only non-money-market funds for the stat calculation.
  const nonMM  = scoredFunds.filter(f => !f.isMoneyMarket);
  const scores = nonMM.map(f => f.composite);

  const med           = median(scores);
  const absDeviations = scores.map(s => Math.abs(s - med));
  const mad           = median(absDeviations);

  // Avoid division by zero when all scores are identical
  const safeMad = mad === 0 ? 1e-9 : mad;

  // Attach modZ and tier to every fund
  const withZ = scoredFunds.map(fund => {
    if (fund.isMoneyMarket) {
      return {
        ticker:    fund.ticker,
        composite: fund.composite,
        modZ:      'MONEY_MARKET',
        tier:      getTierFromModZ('MONEY_MARKET').label,
        _excluded: true,
      };
    }

    const modZ        = 0.6745 * (fund.composite - med) / safeMad;
    const fallbacks   = fund.dataQuality?.fallbackCount ?? 0;
    const isLowData   = fallbacks >= 4;
    const belowMedian = modZ < 0;

    const tier = isLowData
      ? getTierFromModZ('LOW_DATA').label
      : getTierFromModZ(modZ).label;

    return {
      ticker:    fund.ticker,
      composite: fund.composite,
      modZ,
      tier,
      _excluded: belowMedian || isLowData,
    };
  });

  // ── STEP 2 — Exponential Allocation ───────────────────────────────────────
  const rt = clampRisk(Number(riskTolerance));
  const k  = 0.1 + (rt * 0.20);

  const eligible = withZ.filter(f => !f._excluded);

  // Pure exponential: weight = e^(k × Z)
  const rawEntries = eligible.map(fund => ({
    ticker:    fund.ticker,
    rawWeight: Math.exp(k * fund.modZ),
  }));

  const totalRaw = rawEntries.reduce((acc, e) => acc + e.rawWeight, 0) || 1;

  // Normalise to 100 (internal percentages for cap logic)
  const allocMap = {};
  for (const { ticker, rawWeight } of rawEntries) {
    allocMap[ticker] = (rawWeight / totalRaw) * 100;
  }

  // ── STEP 3 — 30% Position Cap ─────────────────────────────────────────────
  // Iteratively redistribute excess from capped funds to uncapped funds.
  const CAP = 30;

  for (let iter = 0; iter < 30; iter++) {
    const capped   = Object.entries(allocMap).filter(([, v]) => v >  CAP);
    const uncapped = Object.entries(allocMap).filter(([, v]) => v <= CAP);

    if (capped.length === 0) break;

    let excess = 0;
    for (const [ticker] of capped) {
      excess          += allocMap[ticker] - CAP;
      allocMap[ticker] = CAP;
    }

    const uncappedSum = uncapped.reduce((acc, [, v]) => acc + v, 0) || 1;
    for (const [ticker, val] of uncapped) {
      allocMap[ticker] = val + excess * (val / uncappedSum);
    }
  }

  // ── STEP 4 — Capture Threshold (risk-scaled fund count) ─────────────────
  // Walk down ranked allocations until cumulative weight hits a risk-scaled
  // target. Trim the tail, then re-normalize survivors to 100%.
  // Fund count is data-driven (responds to score distribution shape) but
  // clamped to [minFunds, maxFunds] guardrails.
  const { captureHigh, captureStep, minFunds, maxFunds } = ALLOCATION_LIMITS;
  const targetCapture = captureHigh - (rt - 1) * captureStep;

  const ranked = Object.entries(allocMap)
    .sort(([, a], [, b]) => b - a);

  let cumulative = 0;
  let keepCount  = 0;

  for (const [, alloc] of ranked) {
    if (keepCount >= maxFunds) break;
    cumulative += alloc;
    keepCount++;
    if (cumulative >= targetCapture && keepCount >= minFunds) break;
  }

  // Clamp to guardrails, and never exceed how many we actually have
  keepCount = Math.max(minFunds, Math.min(maxFunds, keepCount));
  keepCount = Math.min(keepCount, ranked.length);

  // Remove trimmed funds from allocMap
  const kept = new Set(ranked.slice(0, keepCount).map(([t]) => t));
  for (const ticker of Object.keys(allocMap)) {
    if (!kept.has(ticker)) delete allocMap[ticker];
  }

  // Re-normalize survivors to 100%
  const keptSum = Object.values(allocMap).reduce((a, b) => a + b, 0) || 1;
  for (const ticker of Object.keys(allocMap)) {
    allocMap[ticker] = (allocMap[ticker] / keptSum) * 100;
  }

  // ── STEP 5 — Rounding Cleanup ─────────────────────────────────────────────
  // Round each position to 1 decimal place.
  for (const ticker of Object.keys(allocMap)) {
    allocMap[ticker] = parseFloat(allocMap[ticker].toFixed(1));
  }

  // Absorb rounding error into the largest position.
  const roundedSum = Object.values(allocMap).reduce((a, b) => a + b, 0);
  const diff       = parseFloat((100.0 - roundedSum).toFixed(1));

  if (diff !== 0 && Object.keys(allocMap).length > 0) {
    const largest = Object.entries(allocMap)
      .sort(([, a], [, b]) => b - a)[0]?.[0];
    if (largest) {
      allocMap[largest] = parseFloat((allocMap[largest] + diff).toFixed(1));
    }
  }

  // ── STEP 6 — Assemble Return Shape ────────────────────────────────────────
  // { ticker, allocation_pct (0–1 decimal), tier (string), modZ, composite }
  // Sorted by allocation_pct descending. Non-allocated funds have allocation_pct = 0.
  const result = withZ.map(fund => {
    const pctInternal = fund._excluded ? 0 : (allocMap[fund.ticker] ?? 0);

    return {
      ticker:         fund.ticker,
      allocation_pct: parseFloat((pctInternal / 100).toFixed(4)),
      tier:           fund.tier,
      modZ:           fund.modZ,
      composite:      fund.composite,
    };
  });

  return result.sort((a, b) => b.allocation_pct - a.allocation_pct);
}
