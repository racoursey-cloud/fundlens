import { DEFAULT_WEIGHTS, getTierFromModZ } from './constants.js';

// Normalize raw integer weights (e.g. {mandateScore:40,...}) to fractions summing to 1.0.
function normalizeWeights(W) {
  const total = Object.values(W).reduce((s, v) => s + v, 0);
  if (total === 0) {
    const keys = Object.keys(DEFAULT_WEIGHTS);
    return Object.fromEntries(keys.map(k => [k, 1 / keys.length]));
  }
  return Object.fromEntries(Object.entries(W).map(([k, v]) => [k, v / total]));
}

// Compute composite score (1–10) for a single fund.
// factors: { mandateScore, momentum, riskAdj, managerQuality }
// concentrationPenalty: HHI-based penalty computed in pipeline from sectorExposure
// weights: raw integer weights from user_weights (or DEFAULT_WEIGHTS)
export function computeComposite(factors, concentrationPenalty = 0, weights = DEFAULT_WEIGHTS) {
  const W = normalizeWeights(weights);
  const { mandateScore, momentum, riskAdj, managerQuality } = factors;
  return +Math.min(10, Math.max(1,
    mandateScore   * (W.mandateScore   || 0.40) +
    momentum       * (W.momentum       || 0.25) +
    riskAdj        * (W.riskAdj        || 0.20) +
    managerQuality * (W.managerQuality || 0.15)
    - concentrationPenalty
  )).toFixed(2);
}

// HHI-based concentration penalty.
// sectorExposure: { [sectorName]: pctVal } where pctVal is 0–100
export function computeConcentrationPenalty(sectorExposure) {
  const hhi = Object.values(sectorExposure).reduce((s, v) => s + (v / 100) * (v / 100), 0);
  return Math.max(0, (hhi - 0.18) * 1.5);
}

// Apply modified Z-score (median + MAD) across the full fund universe.
// Annotates each fund with modZ and tier. Returns array sorted descending by composite.
// Ported verbatim from v3 applyStatisticalAnalysis.
export function applyStatisticalAnalysis(funds) {
  const scores = funds.map(f => f.composite);

  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const deviations = scores.map(s => Math.abs(s - median));
  const devSorted = [...deviations].sort((a, b) => a - b);
  const mad = n % 2 === 0
    ? (devSorted[n / 2 - 1] + devSorted[n / 2]) / 2
    : devSorted[Math.floor(n / 2)];

  return funds.map(f => {
    const modZ = mad > 0 ? +(0.6745 * (f.composite - median) / mad).toFixed(3) : 0;
    const tier = getTierFromModZ(modZ);
    return { ...f, modZ, tier, median, mad };
  }).sort((a, b) => b.composite - a.composite);
}

// Build risk-tolerance-aware allocation from ranked funds.
// Pure function — ported verbatim from v3 buildAllocation.
export function buildAllocation(rankedFunds, riskTolerance) {
  const rt = riskTolerance || 5;

  const eligible = rankedFunds.filter(f => {
    if (rt <= 3) return f.modZ >= -0.3 && f.riskAdj >= 4.5;
    if (rt <= 5) return f.modZ >= 0.1;
    if (rt <= 7) return f.modZ >= 0.3 || f.composite >= 6;
    return f.modZ >= 0.5 || f.composite >= 5.5;
  });

  if (!eligible.length) return [];

  let maxFunds;
  if (rt <= 2)      maxFunds = Math.min(8, eligible.length);
  else if (rt <= 4) maxFunds = Math.min(6, eligible.length);
  else if (rt <= 6) maxFunds = Math.min(5, eligible.length);
  else              maxFunds = Math.min(3, eligible.length);

  const selected = eligible.slice(0, maxFunds);

  const concentrationPower = 0.5 + rt * 0.15;
  const rawAllocs = selected.map(f => Math.pow(f.composite, concentrationPower));
  const total = rawAllocs.reduce((s, v) => s + v, 0);

  return selected.map((f, i) => ({
    ...f,
    allocationPct: +(rawAllocs[i] / total * 100).toFixed(1),
  }));
}
