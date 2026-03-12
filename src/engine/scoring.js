// FundLens v4 — Scoring Engine
// Computes per-fund composite scores from individual factor scores,
// then applies statistical analysis across the full universe to identify
// exceptional performers.

// ── Factor weights ────────────────────────────────────────────────────────────
// Sum must equal 1.0.  Weights mirror the user_weights schema columns.
// Default weights are applied when a user has not customized their profile.

const DEFAULT_WEIGHTS = {
  mandate_score:   0.30,   // how well the fund's holdings match its stated mandate
  momentum:        0.25,   // price momentum + Sharpe ratio (risk-adjusted return)
  risk_adj:        0.20,   // risk-adjusted performance vs benchmark
  manager_quality: 0.15,   // manager tenure, consistency, and track record
  expenses:        0.10,   // expense ratio (lower is better — inverted before scoring)
};

// ── Composite score ───────────────────────────────────────────────────────────

/**
 * Compute a weighted composite score (0–100) for a single fund.
 *
 * @param {object} factors  - Raw factor scores, each 0–100.
 *   { mandateScore, momentumScore, riskAdjScore, managerScore, expenseScore }
 * @param {object} [weights] - Optional user-customized weights from user_weights table.
 *   { mandate_score, momentum, risk_adj, manager_quality, expenses } (integers 0–100)
 *   Will be normalized to sum to 1.0 before applying.
 * @returns {number} Composite score rounded to two decimal places, 0–100.
 */
export function computeComposite(factors, weights = null) {
  const w = normalizeWeights(weights ?? DEFAULT_WEIGHTS);

  const { mandateScore, momentumScore, riskAdjScore, managerScore, expenseScore } = factors;

  const composite =
    (mandateScore   ?? 0) * w.mandate_score   +
    (momentumScore  ?? 0) * w.momentum        +
    (riskAdjScore   ?? 0) * w.risk_adj        +
    (managerScore   ?? 0) * w.manager_quality +
    (expenseScore   ?? 0) * w.expenses;

  return Math.round(Math.min(100, Math.max(0, composite)) * 100) / 100;
}

/**
 * Normalize a weights object so its values sum to 1.0.
 * Accepts either fractional weights (0.30) or integer weights (30).
 */
function normalizeWeights(raw) {
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const vals = keys.map(k => Math.max(0, raw[k] ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total === 0) return { ...DEFAULT_WEIGHTS };
  const norm = {};
  keys.forEach((k, i) => { norm[k] = vals[i] / total; });
  return norm;
}

// ── Statistical analysis ──────────────────────────────────────────────────────

/**
 * Analyse a universe of scored funds and annotate each with its z-score
 * and percentile rank.  Funds with a z-score >= LEADER_THRESHOLD are
 * flagged as exceptional performers ("leader of the pack").
 *
 * @param {Array<{ ticker: string, composite: number, [key: string]: any }>} scoredFunds
 * @returns {Array} Same array, each element extended with:
 *   { zScore, percentile, isLeader, rank }
 */
export function applyStatisticalAnalysis(scoredFunds) {
  if (!scoredFunds?.length) return [];

  const scores = scoredFunds.map(f => f.composite);
  const mean   = computeMean(scores);
  const stdDev = computeStdDev(scores, mean);

  // Rank descending by composite score (1 = best)
  const sorted = [...scoredFunds].sort((a, b) => b.composite - a.composite);
  const rankMap = {};
  sorted.forEach((f, i) => { rankMap[f.ticker] = i + 1; });

  const n = scores.length;

  return scoredFunds.map(fund => {
    const zScore    = stdDev > 0 ? (fund.composite - mean) / stdDev : 0;
    const rank      = rankMap[fund.ticker];
    const percentile = Math.round(((n - rank) / (n - 1 || 1)) * 100);
    const isLeader  = zScore >= LEADER_THRESHOLD;

    return {
      ...fund,
      zScore:     Math.round(zScore * 1000) / 1000,
      percentile,
      isLeader,
      rank,
    };
  });
}

// A fund must be at least 1.5 standard deviations above the mean to be
// flagged as the leader.  With a universe of ~22 funds this threshold
// reliably surfaces only genuinely exceptional performers.
const LEADER_THRESHOLD = 1.5;

// ── Stat helpers ──────────────────────────────────────────────────────────────

function computeMean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeStdDev(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Expense score helper ──────────────────────────────────────────────────────
// Expense ratios are costs — lower is better.  Convert a gross expense ratio
// (e.g. 0.75 = 0.75%) to a 0–100 score where 0% → 100 and ≥ 2% → 0.

export function expenseRatioToScore(grossExpenseRatio) {
  if (grossExpenseRatio == null) return null;
  const pct = grossExpenseRatio;
  // Linear mapping: 0% → 100, 2% → 0.  Clamped.
  return Math.round(Math.min(100, Math.max(0, (1 - pct / 2) * 100)) * 100) / 100;
}

// ── Momentum score helper ─────────────────────────────────────────────────────
// Combines price return and Sharpe ratio into a single 0–100 momentum score.
// priceReturn: decimal (e.g. 0.12 = +12% over look-back window)
// sharpe:      Sharpe ratio (typically -2 to +3 for mutual funds)

export function momentumToScore(priceReturn, sharpe) {
  // Normalise price return: -20% → 0, +20% → 100
  const returnScore = Math.min(100, Math.max(0, (priceReturn + 0.20) / 0.40 * 100));
  // Normalise Sharpe: -1 → 0, +2 → 100
  const sharpeScore = Math.min(100, Math.max(0, (sharpe + 1) / 3 * 100));
  // Equal blend
  return Math.round((returnScore * 0.5 + sharpeScore * 0.5) * 100) / 100;
}
