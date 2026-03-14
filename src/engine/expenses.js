// FundLens v4 — Expense ratio engine (Finnhub + static fallback, no Claude)
// Fetches expense ratio from Finnhub's mutual fund profile endpoint, caches
// in Supabase for 90 days, and falls back to a static map of known 401(k)
// funds if Finnhub doesn't cover the ticker.
//
// Architecture notes:
// - Fund type derived programmatically from EDGAR holdings (assetCat
//   distribution + name pattern matching). No AI involved.
// - Lookup chain: Supabase cache (90-day TTL) -> Finnhub API -> static map -> neutral.
// - Finnhub free tier = 60 calls/min. With 90-day caching, a typical 20-fund
//   portfolio hits Finnhub at most once per fund per quarter. Repeat runs
//   within 90 days are instant (cache only).
// - Zero Claude calls. Step 5 completes in seconds.
// - Benchmark vintage warning: emits console.warn if ICI/Morningstar thresholds
//   in constants.js are >=2 years old.
//
// !! NO CLAUDE CALLS IN THIS FILE -- sequential call rule does not apply. !!

import { EXPENSE_BENCHMARKS_VINTAGE, EXPENSE_RATIO_THRESHOLDS, MONEY_MARKET_FUNDS } from './constants.js';
import { getFundProfile, setFundProfile } from '../services/cache.js';

// -- Benchmark vintage check --------------------------------------------------
const vintageAge = new Date().getFullYear() - EXPENSE_BENCHMARKS_VINTAGE;
if (vintageAge >= 2) {
  console.warn(
    `[expenses] Expense benchmarks are ${vintageAge} years old (vintage: ${EXPENSE_BENCHMARKS_VINTAGE}).` +
    ` Consider refreshing EXPENSE_RATIO_THRESHOLDS in constants.js from ICI/Morningstar.`
  );
}

// -- Finnhub expense ratio fetch ----------------------------------------------
// Calls /api/finnhub/mutual-fund/profile?symbol=TICKER (Railway proxy injects token).
// Finnhub returns: { name, category, expenseRatio, ... }
// expenseRatio is a percentage value (e.g. 0.75 means 0.75%).
// We convert to decimal (0.75% -> 0.0075) for consistency with our thresholds.
async function fetchExpenseFromFinnhub(ticker) {
  try {
    const res = await fetch(
      `/api/finnhub/mutual-fund/profile?symbol=${encodeURIComponent(ticker)}`
    );

    if (res.status === 429) {
      console.warn(`[expenses] Finnhub rate-limited on ${ticker}, skipping`);
      return null;
    }

    if (!res.ok) {
      console.warn(`[expenses] Finnhub ${res.status} for ${ticker}`);
      return null;
    }

    const data = await res.json();

    // Finnhub returns {} for unknown tickers
    if (!data || typeof data.expenseRatio !== 'number') {
      console.log(`[expenses] Finnhub has no expense data for ${ticker}`);
      return null;
    }

    // Finnhub expenseRatio is a percentage (e.g. 0.75 = 0.75%).
    // Convert to decimal (0.75% -> 0.0075) to match our threshold format.
    const ratioDecimal = data.expenseRatio / 100;

    return {
      gross: ratioDecimal,
      net:   ratioDecimal,  // Finnhub doesn't distinguish gross/net
      note:  data.category ? `Category: ${data.category}` : '',
    };
  } catch (err) {
    console.warn(`[expenses] Finnhub fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

// -- Static fallback map of known 401(k) fund expense ratios ------------------
// Source: fund prospectuses (public data). Values are NET expense ratio as a
// decimal (e.g. 0.0003 = 0.03%). Used only when both Supabase cache and
// Finnhub miss.
const KNOWN_RATIOS = new Map([
  // Fidelity index
  ['FXAIX',  { net: 0.0015, gross: 0.0015 }],
  ['FSKAX',  { net: 0.0015, gross: 0.0015 }],
  ['FTIHX',  { net: 0.0006, gross: 0.0006 }],
  ['FXNAX',  { net: 0.0025, gross: 0.0025 }],
  ['FSMDX',  { net: 0.0025, gross: 0.0025 }],
  ['FSSNX',  { net: 0.0025, gross: 0.0025 }],
  ['FSPSX',  { net: 0.0035, gross: 0.0035 }],
  ['FIPDX',  { net: 0.0005, gross: 0.0005 }],
  // Fidelity active
  ['FCNTX',  { net: 0.0049, gross: 0.0049 }],
  ['FDGRX',  { net: 0.0083, gross: 0.0083 }],
  ['FBGRX',  { net: 0.0079, gross: 0.0079 }],
  ['FLCSX',  { net: 0.0068, gross: 0.0068 }],
  ['FBALX',  { net: 0.0049, gross: 0.0049 }],
  ['FPURX',  { net: 0.0049, gross: 0.0049 }],
  ['FOCPX',  { net: 0.0069, gross: 0.0069 }],
  ['FLPSX',  { net: 0.0052, gross: 0.0052 }],
  // Fidelity Freedom target-date
  ['FFFHX',  { net: 0.0075, gross: 0.0075 }],
  ['FFFGX',  { net: 0.0075, gross: 0.0075 }],
  ['FFFEX',  { net: 0.0075, gross: 0.0075 }],
  ['FFFSX',  { net: 0.0065, gross: 0.0065 }],
  // Fidelity Freedom Index target-date
  ['FIHFX',  { net: 0.0012, gross: 0.0012 }],
  ['FBIFX',  { net: 0.0012, gross: 0.0012 }],
  ['FIOFX',  { net: 0.0012, gross: 0.0012 }],
  // Fidelity money market
  ['FDRXX',  { net: 0.0042, gross: 0.0042 }],
  ['SPAXX',  { net: 0.0042, gross: 0.0042 }],
  // Vanguard index
  ['VFIAX',  { net: 0.0004, gross: 0.0004 }],
  ['VTSAX',  { net: 0.0004, gross: 0.0004 }],
  ['VTIAX',  { net: 0.0012, gross: 0.0012 }],
  ['VBTLX',  { net: 0.0005, gross: 0.0005 }],
  ['VSMAX',  { net: 0.0005, gross: 0.0005 }],
  ['VIMAX',  { net: 0.0005, gross: 0.0005 }],
  ['VGSLX',  { net: 0.0012, gross: 0.0012 }],
  ['VEMAX',  { net: 0.0014, gross: 0.0014 }],
  ['VEXAX',  { net: 0.0005, gross: 0.0005 }],
  // Vanguard active
  ['VWELX',  { net: 0.0026, gross: 0.0026 }],
  ['VPMAX',  { net: 0.0030, gross: 0.0030 }],
  ['VDIGX',  { net: 0.0017, gross: 0.0017 }],
  // Vanguard target-date
  ['VTTHX',  { net: 0.0008, gross: 0.0008 }],
  ['VFORX',  { net: 0.0008, gross: 0.0008 }],
  ['VTTVX',  { net: 0.0008, gross: 0.0008 }],
  // T. Rowe Price
  ['TRBCX',  { net: 0.0070, gross: 0.0070 }],
  ['PRGFX',  { net: 0.0065, gross: 0.0065 }],
  ['PRWCX',  { net: 0.0060, gross: 0.0060 }],
  ['PRHSX',  { net: 0.0073, gross: 0.0073 }],
  // American Funds
  ['AGTHX',  { net: 0.0062, gross: 0.0062 }],
  ['AIVSX',  { net: 0.0059, gross: 0.0059 }],
  ['ANCFX',  { net: 0.0062, gross: 0.0062 }],
  ['AEPGX',  { net: 0.0083, gross: 0.0083 }],
  // Schwab
  ['SWPPX',  { net: 0.0002, gross: 0.0002 }],
  ['SWTSX',  { net: 0.0003, gross: 0.0003 }],
  ['SWISX',  { net: 0.0006, gross: 0.0006 }],
  ['SWAGX',  { net: 0.0004, gross: 0.0004 }],
  // PIMCO
  ['PTTRX',  { net: 0.0050, gross: 0.0050 }],
  ['PIMIX',  { net: 0.0059, gross: 0.0059 }],
  // Dodge & Cox
  ['DODGX',  { net: 0.0051, gross: 0.0051 }],
  ['DODFX',  { net: 0.0062, gross: 0.0062 }],
  ['DODIX',  { net: 0.0042, gross: 0.0042 }],
  // Stable value
  ['ADAXX',  { net: 0.0040, gross: 0.0040 }],
]);

// -- Fund type classification -------------------------------------------------
export function classifyFundType(ticker, fundName, holdings) {
  if (MONEY_MARKET_FUNDS.has(ticker)) return 'moneyMarket';

  const counts = { EC: 0, DBT: 0, STIV: 0, RF: 0, OTHER: 0 };
  for (const h of (holdings ?? [])) {
    const cat = (h.assetCat || '').toUpperCase();
    if (cat in counts) counts[cat]++;
    else counts.OTHER++;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return 'unknown';

  const pct = k => counts[k] / total;

  if (pct('STIV') > 0.5) return 'moneyMarket';
  if (pct('DBT') > 0.5) return isIndexFund(fundName) ? 'indexBond' : 'activeBond';
  if (pct('EC') > 0.3) return isIndexFund(fundName) ? 'indexEquity' : 'activeEquity';

  return 'unknown';
}

function isIndexFund(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return ['index', '500', 'total market', 'russell', 'msci', 'ftse',
          's&p', 'nasdaq', 'dow jones'].some(kw => n.includes(kw));
}

// -- Net-value modifier -------------------------------------------------------
export function calcExpenseModifier(expenseRatio, fundType) {
  if (expenseRatio == null || fundType === 'unknown') return 0;

  const thresholds = EXPENSE_RATIO_THRESHOLDS[fundType];
  if (!thresholds) return 0;

  const { cheap, expensive } = thresholds;

  if (expenseRatio <= cheap)     return  0.5;
  if (expenseRatio >= expensive) return -0.5;

  const t = (expenseRatio - cheap) / (expensive - cheap);
  return Math.round((0.5 - t) * 100) / 100;
}

// -- Public entry point -------------------------------------------------------
// Same signature and return shape as the original version.
// Lookup chain: Supabase cache (90-day) -> Finnhub API -> static map -> neutral.
//
// Returns:
// {
//   gross:      number | null,
//   net:        number | null,
//   note:       string,
//   fundType:   string,
//   modifier:   number,   <- +/-0.5, applied by scoring.js after weighted sum
//   confidence: string,
//   fromCache:  boolean,
// }
//
// Never throws. On any failure, modifier is 0 (neutral).
export async function fetchExpenseData(ticker, fundName, holdings) {
  const fundType = classifyFundType(ticker, fundName, holdings);

  // -- 1. Supabase cache (90-day TTL enforced by getFundProfile) --------------
  try {
    const cached = await getFundProfile(ticker);
    if (cached) {
      const ratio = cached.net ?? cached.gross ?? null;
      const modifier = calcExpenseModifier(ratio, fundType);
      return {
        gross:      cached.gross      ?? null,
        net:        cached.net        ?? null,
        note:       cached.note       ?? '',
        fundType,
        modifier,
        confidence: 'high',
        fromCache:  true,
      };
    }
  } catch (err) {
    console.warn(`[expenses] Cache read failed for ${ticker}:`, err.message);
  }

  // -- 2. Finnhub mutual fund profile API -------------------------------------
  const finnhubResult = await fetchExpenseFromFinnhub(ticker);
  if (finnhubResult) {
    const ratio = finnhubResult.net ?? finnhubResult.gross;
    const modifier = calcExpenseModifier(ratio, fundType);

    // Persist to Supabase cache so future runs skip Finnhub entirely.
    // Only write columns that exist on fund_profiles: ticker, gross, net, note, fetched_at.
    try {
      await setFundProfile(ticker, {
        gross: finnhubResult.gross,
        net:   finnhubResult.net,
        note:  finnhubResult.note,
      });
    } catch (err) {
      console.warn(`[expenses] Cache write failed for ${ticker}:`, err.message);
    }

    return {
      gross:      finnhubResult.gross,
      net:        finnhubResult.net,
      note:       finnhubResult.note,
      fundType,
      modifier,
      confidence: 'high',
      fromCache:  false,
    };
  }

  // -- 3. Static map fallback -------------------------------------------------
  const known = KNOWN_RATIOS.get(ticker);
  if (known) {
    const modifier = calcExpenseModifier(known.net ?? known.gross, fundType);

    // Cache it so we don't re-check Finnhub next run
    try {
      await setFundProfile(ticker, {
        gross: known.gross,
        net:   known.net,
        note:  'From static prospectus data',
      });
    } catch (err) {
      console.warn(`[expenses] Cache write failed for ${ticker}:`, err.message);
    }

    return {
      gross:      known.gross,
      net:        known.net,
      note:       'From static prospectus data',
      fundType,
      modifier,
      confidence: 'medium',
      fromCache:  false,
    };
  }

  // -- 4. No data available -- neutral modifier -------------------------------
  console.log(`[expenses] No expense data for ${ticker} -- neutral modifier`);
  return {
    gross:      null,
    net:        null,
    note:       '',
    fundType,
    modifier:   0,
    confidence: 'low',
    fromCache:  false,
  };
}
