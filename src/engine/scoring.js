// =============================================================================
// FundLens v5 — src/engine/scoring.js
// Composite score calculator.
//
// Inputs: fund list + all sub-score maps from pipeline steps 3–7
// Output: array of fund objects with composite scores, sorted desc.
//
// Formula:
//   raw = (mandateScore × W1) + (momentum × W2) + (riskAdj × W3) + (manager × W4)
//   composite = clamp(raw − concentrationPenalty + expenseModifier, 1.0, 10.0)
//
// Null sub-scores → 5.0 fallback + dataQuality flag
// Money market (FDRXX, ADAXX) → fixed 5.0, all calculation skipped
// =============================================================================

import { MONEY_MARKET_TICKERS } from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Calculates composite scores for all funds.
 *
 * @param {Array}  funds          - [{ ticker, name }, ...] from user fund list
 * @param {Object} mandateScores  - { TICKER: { mandateScore, reasoning } }
 * @param {Object} tiingoData     - { TICKER: { momentum, riskAdj, sharpe, nav } }
 * @param {Object} managerScores  - { TICKER: { score, reasoning } }
 * @param {Object} expenseRatios  - { TICKER: { gross, net, note } }
 * @param {Object} holdingsMap    - { TICKER: [{ sector, weight, ... }] }
 * @param {Object} sectorScores   - { sector: score } from thesis (not used in formula, passed through)
 * @param {Object} weights        - { mandateScore, momentum, riskAdj, managerQuality, risk_tolerance, ... }
 * @returns {Array} Scored fund objects sorted by composite descending
 */
export function calcCompositeScores(
  funds,
  mandateScores,
  tiingoData,
  managerScores,
  expenseRatios,
  holdingsMap,
  sectorScores,
  weights
) {
  // ── Normalize factor weights so they sum to 1.0 ──────────────────────────
  const wKeys = ['mandateScore', 'momentum', 'riskAdj', 'managerQuality'];
  const wSum  = wKeys.reduce((acc, k) => acc + (Number(weights[k]) || 0), 0) || 1;

  const W = {};
  for (const k of wKeys) {
    W[k] = (Number(weights[k]) || 0) / wSum;
  }

  const results = [];

  for (const fund of funds) {
    const ticker = (fund.ticker || '').toUpperCase();

    // ── Money Market — fixed 5.0, skip all calculation ──────────────────────
    if (MONEY_MARKET_TICKERS.has(ticker)) {
      results.push({
        ...fund,
        ticker,
        composite:            5.0,
        mandateScore:         5.0,
        momentum:             5.0,
        riskAdj:              5.0,
        managerQuality:       5.0,
        concentrationPenalty: 0,
        expenseModifier:      0,
        sectorBreakdown:      {},
        mandateReasoning:     null,
        managerReasoning:     null,
        isMoneyMarket:        true,
        dataQuality: {
          mandateFallback:  false,
          momentumFallback: false,
          riskAdjFallback:  false,
          managerFallback:  false,
          fallbackCount:    0,
        },
      });
      continue;
    }

    // ── Sub-score lookup with 5.0 fallback + dataQuality tracking ───────────
    const mandateRaw  = mandateScores?.[ticker]?.mandateScore ?? null;
    const momentumRaw = tiingoData?.[ticker]?.momentum        ?? null;
    const riskAdjRaw  = tiingoData?.[ticker]?.riskAdj         ?? null;
    const managerRaw  = managerScores?.[ticker]?.score        ?? null;

    const mandateFallback  = mandateRaw  === null;
    const momentumFallback = momentumRaw === null;
    const riskAdjFallback  = riskAdjRaw  === null;
    const managerFallback  = managerRaw  === null;

    const mandateScore   = mandateFallback  ? 5.0 : Number(mandateRaw);
    const momentum       = momentumFallback ? 5.0 : Number(momentumRaw);
    const riskAdj        = riskAdjFallback  ? 5.0 : Number(riskAdjRaw);
    const managerQuality = managerFallback  ? 5.0 : Number(managerRaw);

    const fallbackCount = [mandateFallback, momentumFallback, riskAdjFallback, managerFallback]
      .filter(Boolean).length;

    const dataQuality = {
      mandateFallback,
      momentumFallback,
      riskAdjFallback,
      managerFallback,
      fallbackCount,
    };

    // ── Concentration penalty from holdings (HHI) ────────────────────────────
    let concentrationPenalty = 0;
    let sectorBreakdown      = {};

    const holdings = holdingsMap?.[ticker];
    if (Array.isArray(holdings) && holdings.length > 0) {
      // Aggregate raw weights by sector
      const sectorWeights = {};
      let totalWeight = 0;

      for (const h of holdings) {
        const sector = h.sector;
        if (!sector) continue;
        const w = Number(h.weight) || 0;
        sectorWeights[sector] = (sectorWeights[sector] ?? 0) + w;
        totalWeight += w;
      }

      if (totalWeight > 0) {
        // Convert to percentages
        for (const [sec, w] of Object.entries(sectorWeights)) {
          sectorBreakdown[sec] = parseFloat(((w / totalWeight) * 100).toFixed(2));
        }

        // HHI = Σ (pct / 100)²
        const hhi = Object.values(sectorBreakdown)
          .reduce((acc, pct) => acc + Math.pow(pct / 100, 2), 0);

        concentrationPenalty = Math.max(0, (hhi - 0.18) * 1.5);
      }
    }

    // ── Expense modifier ────────────────────────────────────────────────────
    let expenseModifier = 0;
    const expData = expenseRatios?.[ticker];
    if (expData && expData.net != null) {
      const net = Number(expData.net);
      if      (net < 0.005)  expenseModifier =  0.3;
      else if (net > 0.012)  expenseModifier = -0.3;
      // else modifier stays 0
    }

    // ── Composite formula ────────────────────────────────────────────────────
    const raw =
      mandateScore   * W.mandateScore +
      momentum       * W.momentum     +
      riskAdj        * W.riskAdj      +
      managerQuality * W.managerQuality;

    const penalised = raw - concentrationPenalty;
    const modified  = penalised + expenseModifier;
    const composite = clamp(modified, 1.0, 10.0);

    results.push({
      ...fund,
      ticker,
      composite:            parseFloat(composite.toFixed(3)),
      mandateScore:         parseFloat(mandateScore.toFixed(3)),
      momentum:             parseFloat(momentum.toFixed(3)),
      riskAdj:              parseFloat(riskAdj.toFixed(3)),
      managerQuality:       parseFloat(managerQuality.toFixed(3)),
      concentrationPenalty: parseFloat(concentrationPenalty.toFixed(4)),
      expenseModifier,
      sectorBreakdown,
      dataQuality,
      isMoneyMarket:    false,
      mandateReasoning: mandateScores?.[ticker]?.reasoning  ?? null,
      managerReasoning: managerScores?.[ticker]?.reasoning  ?? null,
    });
  }

  // Sort by composite descending
  return results.sort((a, b) => b.composite - a.composite);
}
