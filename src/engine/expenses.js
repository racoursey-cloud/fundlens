// FundLens v4 \u2014 Expense ratio engine (pure math \u2014 no Claude calls)
// Classifies fund type from EDGAR holdings, looks up expense ratio from
// cache or a static map of known 401(k) funds, and returns a \u00b10.5
// net-value modifier for use in scoring.js.
//
// Architecture notes:
// - Fund type derived programmatically from EDGAR holdings (assetCat
//   distribution + name pattern matching). No AI involved.
// - Expense ratios sourced from: (1) Supabase cache (fund_profiles, 90-day TTL),
//   then (2) static KNOWN_RATIOS map of common 401(k) funds (public prospectus data).
// - If neither source has data, modifier is 0 (neutral) \u2014 never penalizes.
// - Zero API calls. Step 5 completes in milliseconds.
// - Benchmark vintage warning: emits console.warn if ICI/Morningstar thresholds
//   in constants.js are \u22652 years old.
//
// !! SEQUENTIAL CLAUDE CALL RULE: NOT APPLICABLE \u2014 this file makes zero Claude calls. !!

import { EXPENSE_BENCHMARKS_VINTAGE, EXPENSE_RATIO_THRESHOLDS, MONEY_MARKET_FUNDS } from './constants.js';
import { getFundProfile, setFundProfile } from '../services/cache.js';

// \u2500\u2500 Benchmark vintage check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const vintageAge = new Date().getFullYear() - EXPENSE_BENCHMARKS_VINTAGE;
if (vintageAge >= 2) {
  console.warn(
    `[expenses] Expense benchmarks are ${vintageAge} years old (vintage: ${EXPENSE_BENCHMARKS_VINTAGE}).` +
    ` Consider refreshing EXPENSE_RATIO_THRESHOLDS in constants.js from ICI/Morningstar.`
  );
}

// \u2500\u2500 Known 401(k) fund expense ratios \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Source: fund prospectuses (public data, updated periodically).
// Values are NET expense ratio as a decimal (e.g. 0.0003 = 0.03%).
// To add a fund: KNOWN_RATIOS.set('TICKER', { net: 0.0045, gross: 0.0050 })
//
// Coverage: ~80 of the most common 401(k) funds across Fidelity, Vanguard,
// T. Rowe Price, American Funds, BlackRock/iShares, Schwab, PIMCO, JPMorgan,
// and other major providers.
const KNOWN_RATIOS = new Map([
  // ---- Fidelity index funds ----
  ['FXAIX',  { net: 0.0015, gross: 0.0015 }],  // 500 Index
  ['FSKAX',  { net: 0.0015, gross: 0.0015 }],  // Total Market Index
  ['FTIHX',  { net: 0.0006, gross: 0.0006 }],  // Total Intl Index
  ['FXNAX',  { net: 0.0025, gross: 0.0025 }],  // US Bond Index
  ['FSMDX',  { net: 0.0025, gross: 0.0025 }],  // Mid Cap Index
  ['FSSNX',  { net: 0.0025, gross: 0.0025 }],  // Small Cap Index
  ['FSPSX',  { net: 0.0035, gross: 0.0035 }],  // Intl Index
  ['FIPDX',  { net: 0.0005, gross: 0.0005 }],  // Inflation-Protected Bond Index

  // ---- Fidelity active funds ----
  ['FCNTX',  { net: 0.0049, gross: 0.0049 }],  // Contrafund
  ['FDGRX',  { net: 0.0083, gross: 0.0083 }],  // Growth Company
  ['FBGRX',  { net: 0.0079, gross: 0.0079 }],  // Blue Chip Growth
  ['FLCSX',  { net: 0.0068, gross: 0.0068 }],  // Large Cap Stock
  ['FBALX',  { net: 0.0049, gross: 0.0049 }],  // Balanced
  ['FPURX',  { net: 0.0049, gross: 0.0049 }],  // Puritan
  ['FMILX',  { net: 0.0046, gross: 0.0046 }],  // New Millennium
  ['FOCPX',  { net: 0.0069, gross: 0.0069 }],  // OTC Portfolio
  ['FLPSX',  { net: 0.0052, gross: 0.0052 }],  // Low-Priced Stock
  ['FSCOX',  { net: 0.0081, gross: 0.0081 }],  // Small Cap Opportunities

  // ---- Fidelity Freedom target-date ----
  ['FFFHX',  { net: 0.0075, gross: 0.0075 }],  // Freedom 2030
  ['FFFGX',  { net: 0.0075, gross: 0.0075 }],  // Freedom 2040
  ['FFFEX',  { net: 0.0075, gross: 0.0075 }],  // Freedom 2025
  ['FFFSX',  { net: 0.0065, gross: 0.0065 }],  // Freedom Income

  // ---- Fidelity Freedom Index target-date ----
  ['FIHFX',  { net: 0.0012, gross: 0.0012 }],  // Freedom Idx 2030
  ['FBIFX',  { net: 0.0012, gross: 0.0012 }],  // Freedom Idx 2040
  ['FIOFX',  { net: 0.0012, gross: 0.0012 }],  // Freedom Idx 2025

  // ---- Fidelity money market / stable value ----
  ['FDRXX',  { net: 0.0042, gross: 0.0042 }],  // Gov Money Market
  ['SPAXX',  { net: 0.0042, gross: 0.0042 }],  // Gov Money Market
  ['FRTXX',  { net: 0.0042, gross: 0.0042 }],  // Treasury Money Market

  // ---- Vanguard index funds ----
  ['VFIAX',  { net: 0.0004, gross: 0.0004 }],  // 500 Index Admiral
  ['VTSAX',  { net: 0.0004, gross: 0.0004 }],  // Total Stock Market Admiral
  ['VTIAX',  { net: 0.0012, gross: 0.0012 }],  // Total Intl Stock Admiral
  ['VBTLX',  { net: 0.0005, gross: 0.0005 }],  // Total Bond Market Admiral
  ['VSMAX',  { net: 0.0005, gross: 0.0005 }],  // Small Cap Index Admiral
  ['VIMAX',  { net: 0.0005, gross: 0.0005 }],  // Mid Cap Index Admiral
  ['VGSLX',  { net: 0.0012, gross: 0.0012 }],  // Real Estate Index Admiral
  ['VEMAX',  { net: 0.0014, gross: 0.0014 }],  // Emerging Mkts Index Admiral
  ['VTABX',  { net: 0.0011, gross: 0.0011 }],  // Total Intl Bond Admiral
  ['VIPSX',  { net: 0.0010, gross: 0.0010 }],  // Inflation-Protected Secs Admiral
  ['VEXAX',  { net: 0.0005, gross: 0.0005 }],  // Extended Market Index Admiral

  // ---- Vanguard active funds ----
  ['VWELX',  { net: 0.0026, gross: 0.0026 }],  // Wellington
  ['VWNAX',  { net: 0.0027, gross: 0.0027 }],  // Windsor II Admiral
  ['VPMAX',  { net: 0.0030, gross: 0.0030 }],  // Primecap Admiral
  ['VHCAX',  { net: 0.0032, gross: 0.0032 }],  // Health Care Admiral
  ['VDIGX',  { net: 0.0017, gross: 0.0017 }],  // Dividend Growth

  // ---- Vanguard target-date ----
  ['VTTHX',  { net: 0.0008, gross: 0.0008 }],  // Target Retirement 2030
  ['VFORX',  { net: 0.0008, gross: 0.0008 }],  // Target Retirement 2040
  ['VTTVX',  { net: 0.0008, gross: 0.0008 }],  // Target Retirement 2025
  ['VTINX',  { net: 0.0008, gross: 0.0008 }],  // Target Retirement Income

  // ---- T. Rowe Price ----
  ['TRBCX',  { net: 0.0070, gross: 0.0070 }],  // Blue Chip Growth
  ['PRGFX',  { net: 0.0065, gross: 0.0065 }],  // Growth Stock
  ['PRWCX',  { net: 0.0060, gross: 0.0060 }],  // Capital Appreciation
  ['PRHSX',  { net: 0.0073, gross: 0.0073 }],  // Health Sciences
  ['RPMGX',  { net: 0.0065, gross: 0.0065 }],  // Mid-Cap Growth
  ['TRSSX',  { net: 0.0046, gross: 0.0046 }],  // Small Cap Stock

  // ---- American Funds ----
  ['AGTHX',  { net: 0.0062, gross: 0.0062 }],  // Growth Fund of America
  ['AIVSX',  { net: 0.0059, gross: 0.0059 }],  // Investment Co of America
  ['ANCFX',  { net: 0.0062, gross: 0.0062 }],  // Fundamental Investors
  ['ANWPX',  { net: 0.0074, gross: 0.0074 }],  // New Perspective
  ['ABALX',  { net: 0.0059, gross: 0.0059 }],  // American Balanced
  ['CWGIX',  { net: 0.0078, gross: 0.0078 }],  // Capital World Growth & Income
  ['CAIBX',  { net: 0.0061, gross: 0.0061 }],  // Capital Income Builder
  ['AMECX',  { net: 0.0065, gross: 0.0065 }],  // Income Fund of America
  ['AEPGX',  { net: 0.0083, gross: 0.0083 }],  // EuroPacific Growth

  // ---- BlackRock / iShares ----
  ['MALOX',  { net: 0.0027, gross: 0.0027 }],  // LifePath Index 2030
  ['LIHOX',  { net: 0.0027, gross: 0.0027 }],  // LifePath Index 2040
  ['LIPOX',  { net: 0.0027, gross: 0.0027 }],  // LifePath Index 2025

  // ---- Schwab ----
  ['SWPPX',  { net: 0.0002, gross: 0.0002 }],  // S&P 500 Index
  ['SWTSX',  { net: 0.0003, gross: 0.0003 }],  // Total Stock Market Index
  ['SWISX',  { net: 0.0006, gross: 0.0006 }],  // Intl Index
  ['SWAGX',  { net: 0.0004, gross: 0.0004 }],  // US Aggregate Bond Index

  // ---- PIMCO ----
  ['PTTRX',  { net: 0.0050, gross: 0.0050 }],  // Total Return
  ['PIMIX',  { net: 0.0059, gross: 0.0059 }],  // Income Instl
  ['PONDX',  { net: 0.0055, gross: 0.0055 }],  // Income D

  // ---- JPMorgan ----
  ['JLGMX',  { net: 0.0044, gross: 0.0044 }],  // Large Cap Growth
  ['SEEGX',  { net: 0.0085, gross: 0.0085 }],  // Equity Income
  ['VSCOX',  { net: 0.0081, gross: 0.0081 }],  // Small Cap Core

  // ---- Dodge & Cox ----
  ['DODGX',  { net: 0.0051, gross: 0.0051 }],  // Stock Fund
  ['DODFX',  { net: 0.0062, gross: 0.0062 }],  // International Stock
  ['DODIX',  { net: 0.0042, gross: 0.0042 }],  // Income Fund

  // ---- MetLife Stable Value (common 401k) ----
  ['ADAXX',  { net: 0.0040, gross: 0.0040 }],  // placeholder for stable value
]);

// \u2500\u2500 Fund type classification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Derives fund type from EDGAR holdings assetCat distribution and fund name.
// Returns one of: 'indexEquity' | 'activeEquity' | 'indexBond' | 'activeBond'
//               | 'moneyMarket' | 'unknown'
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

  if (pct('DBT') > 0.5) {
    return isIndexFund(fundName) ? 'indexBond' : 'activeBond';
  }

  if (pct('EC') > 0.3) {
    return isIndexFund(fundName) ? 'indexEquity' : 'activeEquity';
  }

  return 'unknown';
}

function isIndexFund(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return ['index', '500', 'total market', 'russell', 'msci', 'ftse',
          's&p', 'nasdaq', 'dow jones'].some(kw => n.includes(kw));
}

// \u2500\u2500 Net-value modifier \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Maps expense ratio to a \u00b10.5 modifier using ICI/Morningstar thresholds.
//   ratio \u2264 cheap                \u2192 +0.5
//   cheap < ratio < expensive    \u2192 linear +0.5 \u2192 -0.5
//   ratio \u2265 expensive            \u2192 -0.5
//   unknown fund type            \u2192 0 (neutral)
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

// \u2500\u2500 Public entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Same signature and return shape as the original Claude-based version.
// Returns:
// {
//   gross:      number | null,
//   net:        number | null,
//   note:       string,
//   fundType:   string,
//   modifier:   number,   \u2190 \u00b10.5, applied by scoring.js after weighted sum
//   confidence: string,
//   fromCache:  boolean,
// }
//
// Never throws. On any failure, modifier is 0 (neutral).
export async function fetchExpenseData(ticker, fundName, holdings) {
  const fundType = classifyFundType(ticker, fundName, holdings);

  // 1. Check Supabase cache (fund_profiles table, 90-day TTL)
  try {
    const cached = await getFundProfile(ticker);
    if (cached) {
      const modifier = calcExpenseModifier(cached.net ?? cached.gross, fundType);
      return {
        gross:      cached.gross      ?? null,
        net:        cached.net        ?? null,
        note:       cached.note       ?? '',
        fundType,
        modifier,
        confidence: cached.confidence ?? 'low',
        fromCache:  true,
      };
    }
  } catch (err) {
    console.warn(`[expenses] Cache read failed for ${ticker}:`, err.message);
  }

  // 2. Look up in static map of known 401(k) funds
  const known = KNOWN_RATIOS.get(ticker);
  if (known) {
    const modifier = calcExpenseModifier(known.net ?? known.gross, fundType);

    // Persist to Supabase cache so future lookups are even faster
    try {
      await setFundProfile(ticker, {
        gross:      known.gross,
        net:        known.net,
        note:       '',
        confidence: 'high',
      });
    } catch (err) {
      console.warn(`[expenses] Cache write failed for ${ticker}:`, err.message);
    }

    return {
      gross:      known.gross,
      net:        known.net,
      note:       '',
      fundType,
      modifier,
      confidence: 'high',
      fromCache:  false,
    };
  }

  // 3. No data available \u2014 neutral modifier, no penalty
  console.log(`[expenses] No expense data for ${ticker} \u2014 using neutral modifier`);
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
