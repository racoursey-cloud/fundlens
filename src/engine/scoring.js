// FundLens v4 — Composite score engine
// Combines all engine outputs into a single composite score (1.0–10.0) per fund.
//
// Formula:
//   raw = (mandateScore * W_mandate)
//       + (momentum1to10 * W_momentum)
//       + (sharpe1to10   * W_riskAdj)
//       + (managerScore  * W_managerQuality)
//
//   penalised = raw - concentrationPenalty
//   modified  = penalised + expenseModifier   ← ±0.5, applied after weighted sum
//   composite = clamp(modified, 1.0, 10.0)
//
// Weights come from the user's saved preferences (useAppStore → DEFAULT_WEIGHTS
// as fallback). They are integers summing to 100; divide by 100 for multiplication.
//
// Architecture notes:
// - All sub-scores are normalised to 1–10 before weighting.
// - Null sub-scores fall back to 5.0 (neutral) with a data-quality flag.
// - concentrationPenalty: 0–2 points deducted when top-3 holdings > 30% of NAV.
// - expenseModifier: ±0.5 from expenses.js, applied last before clamping.
// - Money market funds receive a fixed composite of 5.0 (neutral sentinel).
// - Returns a dataQuality object so the UI can display coverage warnings.

import { DEFAULT_WEIGHTS, MONEY_MARKET_FUNDS } from './constants.js';

// ── Normalisation helpers ─────────────────────────────────────────────────────

// Momentum is a raw return (e.g. 0.08 = +8%, -0.15 = -15%).
// Map to 1–10 using a sigmoid-style clamp centred at 0.
// ±20% maps to roughly 9/1; 0% maps to 5.5 (slight positive bias).
export function momentumToScore(momentum) {
  if (momentum == null) return null;
  // Clamp to ±30% then linearly map to 1–10
  const clamped = Math.max(-0.30, Math.min(0.30, momentum));
  return Math.round(((clamped + 0.30) / 0.60) * 9 + 1) * 10 / 10;
}

// Sharpe ratio to 1–10.
// Typical mutual fund range: -1 to +2.5. Map linearly; clamp outside that.
export function sharpeToScore(sharpe) {
  if (sharpe == null) return null;
  const clamped = Math.max(-1.0, Math.min(2.5, sharpe));
  return Math.round(((clamped + 1.0) / 3.5) * 9 + 1) * 10 / 10;
}

// ── Concentration penalty ─────────────────────────────────────────────────────
// Deduct up to 2 points when the top 3 holdings are heavily concentrated.
// holdings: array from edgar.js, sorted by weight desc.
// Only applies to equity funds — bond funds naturally hold many small positions.
export function calcConcentrationPenalty(holdings) {
  if (!holdings?.length) return 0;

  // Only penalise equity-heavy funds
  const equityCount = holdings.filter(h => h.assetCat === 'EC').length;
  if (equityCount < holdings.length * 0.3) return 0; // <30% equity → skip

  const top3Weight = holdings
    .slice(0, 3)
    .reduce((sum, h) => sum + (h.weight ?? 0), 0);

  if (top3Weight <= 30) return 0;
  if (top3Weight >= 60) return 2.0;

  // Linear: 30% → 0 penalty, 60% → 2.0 penalty
  return Math.round(((top3Weight - 30) / 30) * 2.0 * 100) / 100;
}

// ── Main composite scorer ─────────────────────────────────────────────────────
// Arguments:
//   ticker         — fund ticker string
//   mandateScore   — 1–10 from mandate.js (null → 5 fallback)
//   tiingoMetrics  — { momentum, sharpe } from tiingo.js
//   managerScore   — 1–10 from manager.js (null → 5 fallback)
//   expenseResult  — { modifier } from expenses.js
//   holdings       — array from edgar.js (for concentration penalty)
//   weights        — { mandateScore, momentum, riskAdj, managerQuality } integers summing to 100
//
// Returns:
// {
//   composite:           number,   ← 1.0–10.0
//   breakdown: {
//     mandateScore:      number,
//     momentum:          number,
//     riskAdj:           number,
//     managerQuality:    number,
//     concentrationPenalty: number,
//     expenseModifier:   number,
//   },
//   dataQuality: {
//     mandateFallback:   boolean,
//     momentumFallback:  boolean,
//     sharpeFallback:    boolean,
//     managerFallback:   boolean,
//     expenseFallback:   boolean,
//     holdingsFallback:  boolean,
//   },
// }
export function calcCompositeScore({
  ticker,
  mandateScore,
  tiingoMetrics,
  managerScore,
  expenseResult,
  holdings,
  weights = DEFAULT_WEIGHTS,
}) {
  // Money market funds: fixed neutral composite
  if (MONEY_MARKET_FUNDS.has(ticker)) {
    return {
      composite: 5.0,
      breakdown: {
        mandateScore:         5.0,
        momentum:             5.0,
        riskAdj:              5.0,
        managerQuality:       5.0,
        concentrationPenalty: 0,
        expenseModifier:      0,
      },
      dataQuality: {
        mandateFallback:  false,
        momentumFallback: false,
        sharpeFallback:   false,
        managerFallback:  false,
        expenseFallback:  false,
        holdingsFallback: false,
      },
    };
  }

  // Normalise weights to fractions
  const total = (weights.mandateScore ?? 40)
              + (weights.momentum     ?? 25)
              + (weights.riskAdj      ?? 20)
              + (weights.managerQuality ?? 15);

  const W = {
    mandate: (weights.mandateScore  ?? 40) / total,
    momentum: (weights.momentum     ?? 25) / total,
    riskAdj:  (weights.riskAdj      ?? 20) / total,
    manager:  (weights.managerQuality ?? 15) / total,
  };

  // Sub-scores with fallback tracking
  const dataQuality = {
    mandateFallback:  false,
    momentumFallback: false,
    sharpeFallback:   false,
    managerFallback:  false,
    expenseFallback:  false,
    holdingsFallback: false,
  };

  const mandate = mandateScore != null ? mandateScore : (dataQuality.mandateFallback = true, 5.0);

  const rawMomentum = momentumToScore(tiingoMetrics?.momentum ?? null);
  const momentum    = rawMomentum  != null ? rawMomentum  : (dataQuality.momentumFallback = true, 5.0);

  const rawSharpe = sharpeToScore(tiingoMetrics?.sharpe ?? null);
  const sharpe    = rawSharpe != null ? rawSharpe : (dataQuality.sharpeFallback = true, 5.0);

  const manager = managerScore != null ? managerScore : (dataQuality.managerFallback = true, 5.0);

  const expenseModifier = expenseResult?.modifier ?? (dataQuality.expenseFallback = true, 0);

  if (!holdings?.length) dataQuality.holdingsFallback = true;

  // Weighted sum
  const raw = (mandate  * W.mandate)
            + (momentum * W.momentum)
            + (sharpe   * W.riskAdj)
            + (manager  * W.manager);

  // Concentration penalty
  const concentrationPenalty = calcConcentrationPenalty(holdings);

  // Apply expense modifier and clamp
  const modified  = raw - concentrationPenalty + expenseModifier;
  const composite = Math.round(Math.max(1.0, Math.min(10.0, modified)) * 10) / 10;

  // DEBUG — remove after diagnosis
  console.log(`[score] ${ticker} | mandate=${Math.round(mandate*10)/10} mom=${Math.round(momentum*10)/10} sharpe=${Math.round(sharpe*10)/10} mgr=${Math.round(manager*10)/10} exp=${expenseModifier} conc=${concentrationPenalty} → ${composite}`);

  return {
    composite,
    breakdown: {
      mandateScore:         Math.round(mandate  * 10) / 10,
      momentum:             Math.round(momentum * 10) / 10,
      riskAdj:              Math.round(sharpe   * 10) / 10,
      managerQuality:       Math.round(manager  * 10) / 10,
      concentrationPenalty: Math.round(concentrationPenalty * 100) / 100,
      expenseModifier:      Math.round(expenseModifier       * 100) / 100,
    },
    dataQuality,
  };
}
