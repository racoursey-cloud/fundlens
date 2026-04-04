// =============================================================================
// FundLens v5.1 — src/engine/constants.js
// Single source of truth for all configuration constants.
// No other file should hardcode fund lists, sector names, weights, or thresholds.
// =============================================================================

// ---------------------------------------------------------------------------
// AI Models
// ---------------------------------------------------------------------------

export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Fund Universe (22 funds)
// ---------------------------------------------------------------------------

export const DEFAULT_FUNDS = [
  { ticker: 'PRPFX', name: 'Permanent Portfolio I' },
  { ticker: 'WFPRX', name: 'Allspring Special Mid Cap Value' },
  { ticker: 'VFWAX', name: 'Vanguard FTSE All-World ex-US' },
  { ticker: 'QFVRX', name: 'Pear Tree Polaris Foreign Value' },
  { ticker: 'MADFX', name: 'Matrix Advisors Dividend Fund' },
  { ticker: 'VADFX', name: 'Invesco Equal-Weight S&P 500' },
  { ticker: 'RNWGX', name: 'American Funds New World R6' },
  { ticker: 'OIBIX', name: 'Invesco International Bond R6' },
  { ticker: 'RTRIX', name: 'Royce Small-Cap Total Return' },
  { ticker: 'DRRYX', name: 'BNY Mellon Global Real Return' },
  { ticker: 'VWIGX', name: 'Vanguard International Growth' },
  { ticker: 'TGEPX', name: 'TCW Emerging Markets Income' },
  { ticker: 'BPLBX', name: 'BlackRock Inflation Protected Bond' },
  { ticker: 'CFSTX', name: 'Commerce Short Term Government' },
  { ticker: 'MWTSX', name: 'MetWest Total Return Bond' },
  { ticker: 'FXAIX', name: 'Fidelity 500 Index Fund' },
  { ticker: 'FDRXX', name: 'Fidelity Government Cash Reserves' },
  { ticker: 'ADAXX', name: 'Invesco Government Money Market' },
  { ticker: 'WEGRX', name: 'Allspring Emerging Growth R6' },
  { ticker: 'BGHIX', name: 'BrandywineGLOBAL High Yield I' },
  { ticker: 'HRAUX', name: 'Carillon Eagle Mid Cap Growth' },
  { ticker: 'FSPGX', name: 'Fidelity Large Cap Growth Index' },
];

// ---------------------------------------------------------------------------
// Money Market Funds (fixed score 5.0, skip pipeline scoring)
// ---------------------------------------------------------------------------

export const MONEY_MARKET_TICKERS = new Set(['FDRXX', 'ADAXX']);

// ---------------------------------------------------------------------------
// GICS Sectors — { etf, color }
// ---------------------------------------------------------------------------

export const GICS_SECTORS = {
  'Technology':             { etf: 'XLK',  color: '#1D4ED8' },
  'Financials':             { etf: 'XLF',  color: '#059669' },
  'Healthcare':             { etf: 'XLV',  color: '#DC2626' },
  'Consumer Discretionary': { etf: 'XLY',  color: '#D97706' },
  'Consumer Staples':       { etf: 'XLP',  color: '#7C3AED' },
  'Energy':                 { etf: 'XLE',  color: '#B45309' },
  'Industrials':            { etf: 'XLI',  color: '#0891B2' },
  'Materials':              { etf: 'XLB',  color: '#65A30D' },
  'Utilities':              { etf: 'XLU',  color: '#6B7280' },
  'Real Estate':            { etf: 'XLRE', color: '#EC4899' },
  'Communication Services': { etf: 'XLC',  color: '#8B5CF6' },
};

// ---------------------------------------------------------------------------
// Scoring Weights (must sum to 100)
// Information-ratio justified (Jegadeesh & Titman 1993, Novy-Marx 2013):
//   Momentum — strongest empirical premium, most persistent factor
//   Quality  — fundamental data, meaningful and data-driven premium
//   Positioning — tactical sector view, lowest documented reliability
// ---------------------------------------------------------------------------

export const DEFAULT_WEIGHTS = {
  sectorAlignment:  25,
  momentum:         40,
  holdingsQuality:  35,
};

// ---------------------------------------------------------------------------
// Factor Display Labels
// ---------------------------------------------------------------------------

export const FACTOR_LABELS = {
  sectorAlignment:  'Positioning',
  momentum:         'Momentum',
  holdingsQuality:  'Quality',
};

export const FACTOR_KEYS = ['sectorAlignment', 'momentum', 'holdingsQuality'];

// ---------------------------------------------------------------------------
// Expense Modifier Thresholds (±0.5)
// ---------------------------------------------------------------------------

export const EXPENSE_THRESHOLDS = {
  lowCutoff:  0.005,   // net expense ratio below this → +bonus
  highCutoff: 0.012,   // net expense ratio above this → −penalty
  bonus:      0.5,
  penalty:   -0.5,
};

// ---------------------------------------------------------------------------
// Flow Modifier (±0.2)
// From NPORT fund-level flow data (subscriptions − redemptions)
// ---------------------------------------------------------------------------

export const FLOW_MODIFIER = {
  inflow:  0.2,
  outflow: -0.2,
};

// ---------------------------------------------------------------------------
// Concentration Penalty (0–2 range)
// HHI-based, scales inversely with risk tolerance slider
// ---------------------------------------------------------------------------

export const CONCENTRATION = {
  hhiBaseline:    0.15,   // HHI below this → no penalty
  scalingFactor:  2.35,   // maps excess HHI to 0–2 penalty range
  riskBase:       1.5,    // risk_multiplier = riskBase − (riskTolerance − 1) × riskStep
  riskStep:       0.125,  // per-notch reduction in penalty strength
  // risk_tolerance=1 (Diversified)   → multiplier = 1.500 (strongest penalty)
  // risk_tolerance=5 (balanced)      → multiplier = 1.000 (neutral)
  // risk_tolerance=9 (Concentrated)  → multiplier = 0.500 (weakest penalty)
};

// ---------------------------------------------------------------------------
// Quality Confidence Scaling (Grinold 1989 Fundamental Law)
// When Finnhub coverage is below fullConfidenceAt, quality weight scales
// linearly by coverage_pct / fullConfidenceAt, floored at minConfidence.
// Freed weight redistributes to momentum (always data-complete via Tiingo).
// ---------------------------------------------------------------------------

export const QUALITY_CONFIDENCE = {
  fullConfidenceAt: 0.40,   // coverage_pct at which quality gets full weight
  minConfidence:    0.10,   // floor: quality weight never drops below 10% of base
};

// ---------------------------------------------------------------------------
// Allocation Limits — capture-threshold fund count control
// After risk-scaled position cap (25–45%) and exponential weighting,
// walk down ranked allocations until cumulative weight hits a risk-scaled
// target. Fund count is fully data-driven — the cap and capture threshold
// work together to produce the right number of funds organically.
//
// Research basis:
//   O'Neal 1997 — 4 funds halves terminal wealth dispersion
//   Cuthbertson 2022 — alpha declines monotonically as portfolio size grows
//   DiVA 2025 — 2–6 optimal for risk-averse, 1–2 for risk-aggressive
// ---------------------------------------------------------------------------

export const ALLOCATION_LIMITS = {
  captureHigh:  65,   // cumulative weight target (%) at risk 1
  captureStep:   3,   // target drops by this per risk notch
  // Fund count is fully data-driven — no artificial floor or ceiling.
  // The risk-scaled position cap (25% at risk 1, 45% at risk 9) provides
  // a natural floor; the capture threshold provides a natural ceiling.
  //   risk 1 → target 65%, cap 25%  →  ~7 funds
  //   risk 5 → target 53%, cap 35%  →  ~5 funds
  //   risk 9 → target 41%, cap 45%  →  ~3 funds
};

// ---------------------------------------------------------------------------
// Tier Classification — Modified Z-Score thresholds
// ---------------------------------------------------------------------------

/**
 * Returns { label, color, description } for a given Modified Z-Score.
 * Special string values 'MONEY_MARKET' and 'LOW_DATA' are also handled.
 *
 * @param {number|string} modZ
 * @returns {{ label: string, color: string, description: string }}
 */
export function getTierFromModZ(modZ) {
  if (modZ === 'MONEY_MARKET') {
    return { label: 'MM',       color: '#6B7280', description: 'Money market fund' };
  }
  if (modZ === 'LOW_DATA') {
    return { label: 'Low Data', color: '#6B7280', description: 'Insufficient data for classification' };
  }

  const z = Number(modZ);

  if (z >= 2.0) {
    return { label: 'BREAKAWAY', color: '#d97706', description: 'Statistically exceptional' };
  }
  if (z >= 1.2) {
    return { label: 'STRONG',    color: '#059669', description: 'Meaningfully above average' };
  }
  if (z >= 0.3) {
    return { label: 'SOLID',     color: '#3b82f6', description: 'Above average' };
  }
  if (z >= -0.5) {
    return { label: 'NEUTRAL',   color: '#6b7280', description: 'In line with peers' };
  }
  return   { label: 'WEAK',      color: '#ef4444', description: 'Below average' };
}

// ---------------------------------------------------------------------------
// Seed Scores — displayed before first pipeline run completes
// All sub-scores and composite default to 5.0
// ---------------------------------------------------------------------------

const _defaultSeed = () => ({
  composite:        5.0,
  sectorAlignment:  5.0,
  momentum:         5.0,
  holdingsQuality:  5.0,
});

export const SEED_SCORES = Object.fromEntries(
  DEFAULT_FUNDS.map(({ ticker }) => [ticker, _defaultSeed()])
);

// ---------------------------------------------------------------------------
// Static Expense Map — fallback when Finnhub is unavailable
// Values are annual expense ratios (e.g. 0.0082 = 0.82%)
// ---------------------------------------------------------------------------

export const STATIC_EXPENSE_MAP = {
  PRPFX: { gross: 0.0082, net: 0.0082 },
  WFPRX: { gross: 0.0112, net: 0.0112 },
  VFWAX: { gross: 0.0011, net: 0.0011 },
  QFVRX: { gross: 0.0124, net: 0.0124 },
  MADFX: { gross: 0.0090, net: 0.0090 },
  VADFX: { gross: 0.0020, net: 0.0020 },
  RNWGX: { gross: 0.0065, net: 0.0065 },
  OIBIX: { gross: 0.0060, net: 0.0060 },
  RTRIX: { gross: 0.0116, net: 0.0116 },
  DRRYX: { gross: 0.0098, net: 0.0098 },
  VWIGX: { gross: 0.0031, net: 0.0031 },
  TGEPX: { gross: 0.0085, net: 0.0085 },
  BPLBX: { gross: 0.0018, net: 0.0018 },
  CFSTX: { gross: 0.0070, net: 0.0070 },
  MWTSX: { gross: 0.0038, net: 0.0038 },
  FXAIX: { gross: 0.0015, net: 0.0015 },
  FDRXX: { gross: 0.0042, net: 0.0042 },
  ADAXX: { gross: 0.0052, net: 0.0052 },
  WEGRX: { gross: 0.0100, net: 0.0100 },
  BGHIX: { gross: 0.0055, net: 0.0055 },
  HRAUX: { gross: 0.0090, net: 0.0090 },
  FSPGX: { gross: 0.0035, net: 0.0035 },
};

// ---------------------------------------------------------------------------
// Pipeline Step Labels (11 steps, in order)
// ---------------------------------------------------------------------------

export const PIPELINE_STEPS = [
  'Fetching economic data',
  'Generating investment thesis',
  'Loading fund holdings',
  'Classifying holdings by sector',
  'Fetching price metrics',
  'Fetching holdings fundamentals',
  'Analyzing expense ratios',
  'Computing composite scores',
  'Detecting outliers & computing allocation',
  'Generating investor letter',
  'Saving results',
];
