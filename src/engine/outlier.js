// =============================================================================
// FundLens v5 — src/engine/outlier.js
// Modified Z-Score outlier detection + exponential allocation engine.
//
// Steps:
//   1. Modified Z-Score on composite scores (money market excluded)
//   2. Quality gates: below-median (modZ < 0) or low-data (≥4 fallbacks) → 0%
//   3. Exponential allocation: k = 0.1 + (riskTolerance × 0.20)
//   4. 30% per-fund hard cap with proportional redistribution
//   5. Round to 1 decimal, absorb rounding error into largest holding
// =============================================================================

import { getTierFromModZ } from './constants.js';

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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attaches modZ, tier, and allocPct to every fund.
 *
 * @param {Array}  scoredFunds   - Output of calcCompositeScores()
 * @param {number} riskTolerance - Slider value 1–9
 * @returns {Array} Fund objects with modZ, tier, allocPct, sorted by composite desc
 */
export function computeOutliersAndAllocation(scoredFunds, riskTolerance) {
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

  const withZ = scoredFunds.map(fund => {
    if (fund.isMoneyMarket) {
      return {
        ...fund,
        modZ:    'MONEY_MARKET',
        tier:    getTierFromModZ('MONEY_MARKET'),
        allocPct: 0,
      };
    }

    const modZ = 0.6745 * (fund.composite - med) / safeMad;
    const tier = (fund.dataQuality?.fallbackCount ?? 0) >= 4
      ? getTierFromModZ('LOW_DATA')
      : getTierFromModZ(modZ);

    return { ...fund, modZ, tier };
  });

  // ── STEP 2 — Quality Gates ────────────────────────────────────────────────
  // Gate 1: below median → excluded (modZ < 0)
  // Gate 2: low data confidence → excluded (fallbackCount >= 4)
  // Money market: always excluded from allocation
  const gated = withZ.map(fund => {
    if (fund.isMoneyMarket) return { ...fund, _excluded: true };

    const belowMedian  = fund.modZ < 0;
    const lowData      = (fund.dataQuality?.fallbackCount ?? 0) >= 4;

    return { ...fund, _excluded: belowMedian || lowData };
  });

  // ── STEP 3 — Exponential Allocation ──────────────────────────────────────
  const rt = clampRisk(Number(riskTolerance));
  const k  = 0.1 + (rt * 0.20);

  const eligible = gated.filter(f => !f._excluded);

  // rawWeight = composite × e^(modZ × k)
  const rawEntries = eligible.map(fund => ({
    ticker:    fund.ticker,
    rawWeight: fund.composite * Math.exp(fund.modZ * k),
  }));

  const totalRaw = rawEntries.reduce((acc, e) => acc + e.rawWeight, 0) || 1;

  // Normalise to 1.0 (fractional — FundDetailSidebar multiplies ×100 for display)
  const allocMap = {};
  for (const { ticker, rawWeight } of rawEntries) {
    allocMap[ticker] = rawWeight / totalRaw;  // fraction 0-1; sidebar multiplies by 100 for display
  }

  // ── STEP 4 — 30% Position Cap ─────────────────────────────────────────────
  // Iteratively redistribute excess from capped funds to uncapped funds.
  const CAP = 0.30;  // 30% expressed as fraction

  for (let iter = 0; iter < 30; iter++) {
    const capped   = Object.entries(allocMap).filter(([, v]) => v >  CAP);
    const uncapped = Object.entries(allocMap).filter(([, v]) => v <= CAP);

    if (capped.length === 0) break;

    // Collect excess
    let excess = 0;
    for (const [ticker] of capped) {
      excess          += allocMap[ticker] - CAP;
      allocMap[ticker] = CAP;
    }

    // Redistribute proportionally to uncapped funds
    const uncappedSum = uncapped.reduce((acc, [, v]) => acc + v, 0) || 1;
    for (const [ticker, val] of uncapped) {
      allocMap[ticker] = val + excess * (val / uncappedSum);
    }
  }

  // ── STEP 5 — Final Cleanup ────────────────────────────────────────────────
  // Round each position to 1 decimal place.
  for (const ticker of Object.keys(allocMap)) {
    allocMap[ticker] = parseFloat(allocMap[ticker].toFixed(4));
  }

  // Absorb rounding error into the largest position.
  const roundedSum = Object.values(allocMap).reduce((a, b) => a + b, 0);
  const diff       = parseFloat((1.0  - roundedSum).toFixed(4));

  if (diff !== 0 && Object.keys(allocMap).length > 0) {
    const largest = Object.entries(allocMap)
      .sort(([, a], [, b]) => b - a)[0]?.[0];
    if (largest) {
      allocMap[largest] = parseFloat((allocMap[largest] + diff).toFixed(4));
    }
  }

  // ── Assemble final output ─────────────────────────────────────────────────
  const final = gated.map(fund => {
    const allocPct = fund._excluded ? 0 : (allocMap[fund.ticker] ?? 0);

    // Strip internal _excluded flag from output
    const { _excluded, ...rest } = fund;   // eslint-disable-line no-unused-vars
    return { ...rest, allocPct };
  });

  // Sort by composite descending (money market floats to bottom naturally
  // because their composite is always 5.0 and most scored funds score above that)
  return final.sort((a, b) => b.composite - a.composite);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Clamp risk tolerance to the valid 1–9 slider range. */
function clampRisk(rt) {
  if (!Number.isFinite(rt)) return 5;
  return Math.min(9, Math.max(1, rt));
}
