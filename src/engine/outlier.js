// FundLens v4 — outlier.js
// Continuous Modified Z-Score outlier detection + exponential allocation engine.
//
// Pure math — no API calls, no async, no side effects.
// Runs instantly after composite scoring (pipeline Step 8) and before history save.
//
// Inputs:  scored fund array + risk tolerance (1–9)
// Outputs: same fund array enriched with { zScore, allocPct } per fund
//
// Design:
//   1. Compute Modified Z-Score for each fund using MAD (robust to small samples)
//   2. Convert Z-scores to allocation weights via exponential curve
//   3. Risk tolerance controls the curve steepness (k), range 1–9:
//      - Risk 1  → k = 0.30  (nearly flat, minimal concentration)
//      - Risk 9  → k = 1.90  (aggressive tilt toward leaders)
//      Hard cap of 30% per fund — within 401K diversification norms.
//   4. DATA CONFIDENCE GATE: Funds with 4+ of 6 dataQuality fallback flags
//      are excluded from allocation entirely. Their composite is built on
//      mostly-guessed data and should not drive investment decisions.
//      They still appear in Rankings with scores + warning badges.
//   5. MEDIAN QUALITY GATE: Only funds at or above the median (Z-score >= 0)
//      receive any allocation. Below-median funds get hard zero.
//      This is a fixed floor — not tunable — ensuring investors are
//      never recommended a fund on the wrong side of the pack.
//   6. Among qualifying funds, exponential weighting means the lowest
//      qualifiers get small allocations while leaders dominate.
//   7. Money market funds are excluded from Z-score calculation entirely.
//      They receive no allocation from this engine.
//
// The getTierFromModZ() function in constants.js provides display-friendly
// tier labels (BREAKAWAY, STRONG, SOLID, NEUTRAL, WEAK) but those tiers
// have NO effect on allocation math — they are cosmetic only.

import { MONEY_MARKET_FUNDS, getTierFromModZ } from './constants.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the median of a sorted-ascending numeric array.
 * @param {number[]} sorted
 * @returns {number}
 */
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute Median Absolute Deviation.
 * MAD = median(|xi - median(x)|)
 * @param {number[]} values — unsorted
 * @param {number} med — pre-computed median
 * @returns {number}
 */
function mad(values, med) {
  const deviations = values.map(v => Math.abs(v - med));
  deviations.sort((a, b) => a - b);
  return median(deviations);
}

/**
 * Count how many dataQuality flags are true (fallback was used).
 * @param {Object} dq — dataQuality object from scoring.js
 * @returns {number} — 0–6
 */
function countFallbacks(dq) {
  if (!dq) return 6; // no dataQuality at all = treat as fully unknown
  let count = 0;
  if (dq.mandateFallback)  count++;
  if (dq.momentumFallback) count++;
  if (dq.sharpeFallback)   count++;
  if (dq.managerFallback)  count++;
  if (dq.expenseFallback)  count++;
  if (dq.holdingsFallback) count++;
  return count;
}

// Maximum fallback flags before a fund is excluded from allocation.
// 4+ of 6 = near-total data loss. Fund still shows in Rankings with a
// warning badge but receives 0% allocation.
const MAX_FALLBACKS = 3; // funds with MORE than this many are excluded

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Enrich scored funds with Modified Z-Scores, tier labels, and continuous
 * allocation percentages driven by an exponential weighting curve.
 *
 * @param {Array<{ticker: string, composite: number, [key: string]: any}>} scoredFunds
 *   Fund objects from pipeline Step 8. Must have at least `ticker` and `composite`.
 *   Money market funds (FDRXX, ADAXX) are passed through unchanged with
 *   zScore = 0, tier = 'MONEY_MARKET', allocPct = 0.
 *
 * @param {number} riskTolerance
 *   Integer 1–9 from user profile. Controls exponential curve steepness.
 *
 * @returns {Array<{ticker: string, composite: number, zScore: number, tier: string, allocPct: number, ...}>}
 *   Same fund array (same order as input), each fund enriched with:
 *     - zScore:   Modified Z-Score (0 for money market funds)
 *     - tier:     Display label from getTierFromModZ() ('MONEY_MARKET' for MM funds)
 *     - allocPct: Recommended allocation percentage (0 for MM funds, sums to 100 for rest)
 */
export function computeOutliersAndAllocation(scoredFunds, riskTolerance) {
  if (!scoredFunds?.length) return [];

  // Clamp risk tolerance to valid range
  const rt = Math.max(1, Math.min(9, riskTolerance ?? 5));

  // Separate money market funds and low-confidence funds
  const scorable = [];
  const mmIndices = new Set();
  const lowConfIndices = new Set(); // 4+ fallback flags → excluded from allocation

  for (let i = 0; i < scoredFunds.length; i++) {
    if (MONEY_MARKET_FUNDS.has(scoredFunds[i].ticker)) {
      mmIndices.add(i);
    } else {
      // Check data confidence — funds with 4+ fallbacks are scored but not allocated
      if (countFallbacks(scoredFunds[i].dataQuality) > MAX_FALLBACKS) {
        lowConfIndices.add(i);
      }
      scorable.push({ index: i, composite: scoredFunds[i].composite });
    }
  }

  // Edge case: all funds are money market
  if (scorable.length === 0) {
    return scoredFunds.map(f => ({
      ...f,
      zScore: 0,
      tier: 'MONEY_MARKET',
      allocPct: 0,
    }));
  }

  // ── Step 1: Modified Z-Scores ───────────────────────────────────────────

  const composites = scorable.map(s => s.composite);
  const sorted = [...composites].sort((a, b) => a - b);
  const med = median(sorted);
  const madVal = mad(composites, med);

  // If MAD is 0 (all scores identical), Z-scores are all 0.
  // 0.6745 normalization constant converts MAD to σ-equivalent.
  const NORM = 0.6745;
  const zScores = composites.map(c =>
    madVal === 0 ? 0 : (NORM * (c - med)) / madVal
  );

  // ── Step 2: Exponential allocation weights ──────────────────────────────
  //
  // QUALITY GATE: Only funds at or above the median (Z-score >= 0) receive
  // any allocation. This is a fixed floor — not tunable by risk tolerance.
  // Investors are never recommended a fund on the wrong side of the pack.
  //
  // Among qualifying funds:
  //   weight_i = composite_i × e^(zScore_i × k)
  //
  // k = 0.1 + (riskTolerance × 0.20)
  //   Risk 1  → k = 0.30  (nearly score-proportional among qualifiers)
  //   Risk 5  → k = 1.10  (moderate tilt — leader ~28%, tail ~3%)
  //   Risk 9  → k = 1.90  (aggressive tilt, top funds hit 30% cap)
  //
  // 401K context (source: NerdWallet, Ramsey, Fidelity, Bogleheads):
  //   Unlike individual stocks, each 401K fund already holds dozens or
  //   hundreds of securities. Concentration risk here is about asset class
  //   and style overlap, not single-security exposure. Standard 401K
  //   advice splits contributions across fund categories:
  //     - Ramsey: 25% each across 4 fund types
  //     - NerdWallet: 50/30/10/10 across cap sizes + international
  //     - No mainstream 401K advisor recommends >30% in a single fund
  //   Risk tolerance adjusts the tilt toward top-scoring funds but the
  //   25% cap ensures no single fund dominates the allocation.
  //
  // POSITION CAP: No single fund may exceed MAX_POSITION_PCT. Excess weight
  // is redistributed proportionally among uncapped funds to preserve the
  // relative ranking signal while enforcing a prudent ceiling.

  const Z_FLOOR = 0;             // median gate — funds below this get 0%
  const MAX_POSITION_PCT = 30.0; // hard cap per fund (401K diversification norm)

  const k = 0.1 + (rt * 0.20);

  const rawWeights = scorable.map((s, i) => {
    const qualified = zScores[i] >= Z_FLOOR && !lowConfIndices.has(s.index);
    return {
      index:  s.index,
      weight: qualified ? s.composite * Math.exp(zScores[i] * k) : 0,
      zScore: zScores[i],
    };
  });

  // Normalize weights to sum to 100%
  const totalWeight = rawWeights.reduce((sum, rw) => sum + rw.weight, 0);

  const allocMap = {};
  for (const rw of rawWeights) {
    const pct = totalWeight > 0
      ? Math.round((rw.weight / totalWeight) * 1000) / 10  // 1 decimal place
      : 0;
    allocMap[rw.index] = { zScore: rw.zScore, allocPct: pct };
  }

  // ── Position cap: redistribute excess from capped funds ────────────────
  // Iterative redistribution — a capped fund's excess flows proportionally
  // to uncapped funds, which may themselves then hit the cap. Converges in
  // 2–3 passes for typical fund counts.
  for (let pass = 0; pass < 5; pass++) {
    let excess = 0;
    let uncappedTotal = 0;

    for (const [, v] of Object.entries(allocMap)) {
      if (v.allocPct > MAX_POSITION_PCT) {
        excess += v.allocPct - MAX_POSITION_PCT;
        v.allocPct = MAX_POSITION_PCT;
      } else if (v.allocPct > 0) {
        uncappedTotal += v.allocPct;
      }
    }

    if (excess < 0.05 || uncappedTotal === 0) break; // converged

    // Redistribute proportionally among uncapped funds
    for (const [, v] of Object.entries(allocMap)) {
      if (v.allocPct > 0 && v.allocPct < MAX_POSITION_PCT) {
        v.allocPct = Math.round((v.allocPct + (excess * v.allocPct / uncappedTotal)) * 10) / 10;
      }
    }
  }

  // Fix rounding so non-MM percentages sum to exactly 100.0
  const allocEntries = Object.entries(allocMap);
  const currentSum = allocEntries.reduce((s, [, v]) => s + v.allocPct, 0);
  const roundingError = Math.round((100.0 - currentSum) * 10) / 10;

  if (roundingError !== 0 && allocEntries.length > 0) {
    // Apply rounding correction to the highest-weighted fund
    const maxEntry = allocEntries.reduce((best, entry) =>
      entry[1].allocPct > best[1].allocPct ? entry : best
    );
    allocMap[maxEntry[0]].allocPct =
      Math.round((maxEntry[1].allocPct + roundingError) * 10) / 10;
  }

  // ── Step 3: Enrich fund objects ─────────────────────────────────────────

  return scoredFunds.map((fund, i) => {
    if (mmIndices.has(i)) {
      return {
        ...fund,
        zScore:   0,
        tier:     'MONEY_MARKET',
        allocPct: 0,
      };
    }

    const { zScore, allocPct } = allocMap[i];
    const isLowConf = lowConfIndices.has(i);
    return {
      ...fund,
      zScore:   Math.round(zScore * 100) / 100,  // 2 decimal places
      tier:     isLowConf ? 'LOW_DATA' : getTierFromModZ(zScore),
      allocPct,
    };
  });
}
