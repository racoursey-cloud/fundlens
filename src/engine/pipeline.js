// FundLens v4 \u2014 Pipeline orchestrator
// Coordinates all engine files in the correct order, handles errors,
// reports progress, and returns the full scored result set.
//
// Architecture notes:
// - Manager scoring and EDGAR holdings start immediately (background tasks)
//   before Step 1 begins, since both are slow and independent of world data.
// - World data \u2192 Thesis \u2192 Holdings \u2192 Tiingo \u2192 Expenses \u2192 Manager \u2192 Mandate \u2192 Score \u2192 Outlier
// - Every engine call is wrapped in try/catch. Only mandate coverage failure
//   aborts the pipeline; all other failures degrade gracefully to 5.0 fallback.
// - Money market funds (FDRXX, ADAXX) skip edgar, tiingo, expenses, mandate
//   regardless of dataSourcePrefs. scoring.js returns a fixed 5.0 for them.
// - onProgress(step, detail) is called before each major step so the UI can
//   display which stage is running.
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// !! SEQUENTIAL CLAUDE CALLS \u2014 MANDATORY                                      !!
// !! Steps that call Claude (manager, mandate) process funds SEQUENTIALLY    !!
// !! with delays between API calls. Do NOT use Promise.all() for any step    !!
// !! that calls /api/claude. Tiingo, EDGAR, Finnhub, and expenses are        !!
// !! external APIs and CAN run in parallel.                                  !!
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

import { MONEY_MARKET_FUNDS } from './constants.js';
import { fetchWorldData }      from './world.js';
import { generateThesis }      from './thesis.js';
import { fetchHoldings }       from './edgar.js';
import { fetchTiingoMetrics }  from './tiingo.js';
import { fetchExpenseData }    from './expenses.js';
import { scoreManagers }       from './manager.js';
import { scoreMandates }       from './mandate.js';
import { calcCompositeScore }  from './scoring.js';
import { computeOutliersAndAllocation } from './outlier.js';
import { saveRunHistory }      from '../services/cache.js';

// \u2500\u2500 Source enabled helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// A missing key defaults to ENABLED \u2014 only explicit `false` disables a source.
function isEnabled(dataSourcePrefs, key) {
  return dataSourcePrefs[key] !== false;
}

// \u2500\u2500 Public entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
/**
 * Run the full FundLens scoring pipeline.
 *
 * @param {Array<{ticker: string, name: string}>} funds
 * @param {{mandateScore: number, momentum: number, riskAdj: number, managerQuality: number}} weights
 * @param {string} userId
 * @param {Object} dataSourcePrefs  \u2014 { [key]: boolean }; missing keys default to enabled
 * @param {Function} onProgress     \u2014 (step: number, detail: string) => void
 * @param {number} riskTolerance    \u2014 1\u201310, controls allocation concentration curve
 * @returns {Promise<Object>}       \u2014 full result object (see shape below)
 */
export async function runPipeline(funds, weights, userId, dataSourcePrefs = {}, onProgress = () => {}, riskTolerance = 5) {
  const errors = [];

  // Separate non-money-market funds \u2014 only these go through scoring engines
  const scorableFunds = funds.filter(f => !MONEY_MARKET_FUNDS.has(f.ticker));
  const mmFunds       = funds.filter(f =>  MONEY_MARKET_FUNDS.has(f.ticker));

  // \u2500\u2500 t=0: Start slow background tasks immediately \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Manager scoring: independent of world data, starts now
  const managerPromise = isEnabled(dataSourcePrefs, 'manager')
    ? scoreManagers(scorableFunds).catch(err => {
        errors.push(`Manager scoring failed: ${err.message}`);
        return {};
      })
    : Promise.resolve({});

  // EDGAR holdings: one promise per non-MM fund, all start in parallel
  const edgarPromiseMap = {};
  for (const fund of scorableFunds) {
    edgarPromiseMap[fund.ticker] = isEnabled(dataSourcePrefs, 'edgar')
      ? fetchHoldings(fund.ticker, fund.name).catch(() => [])
      : Promise.resolve([]);
  }

  // \u2500\u2500 Step 1 \u2014 World Data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  onProgress(1, 'Fetching economic data...');

  let worldData;
  try {
    worldData = await fetchWorldData();
  } catch (err) {
    errors.push(`World data fetch failed: ${err.message}`);
    worldData = { fredData: {}, headlines: [], treasuryData: null, fetchedAt: new Date().toISOString() };
  }

  // Filter world data based on dataSourcePrefs
  const filteredWorldData = { ...worldData };

  // Remove disabled FRED series
  if (filteredWorldData.fredData) {
    const filteredFred = {};
    for (const [seriesId, entry] of Object.entries(filteredWorldData.fredData)) {
      if (isEnabled(dataSourcePrefs, `fred.${seriesId}`)) {
        filteredFred[seriesId] = entry;
      }
    }
    filteredWorldData.fredData = filteredFred;
  }

  // Disable Treasury data if toggled off
  if (!isEnabled(dataSourcePrefs, 'treasury')) {
    filteredWorldData.treasuryData = null;
  }

  // Disable headlines if toggled off
  if (!isEnabled(dataSourcePrefs, 'headlines')) {
    filteredWorldData.headlines = [];
  }

  // \u2500\u2500 Step 2 \u2014 Thesis \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  onProgress(2, 'Generating investment thesis...');

  let thesisResult;
  try {
    thesisResult = await generateThesis(filteredWorldData);
  } catch (err) {
    errors.push(`Thesis generation failed: ${err.message}`);
    // generateThesis never throws (returns fallback internally), but guard anyway
    thesisResult = {
      investmentThesis: 'Thesis unavailable.',
      dominantTheme:    'Unavailable',
      macroStance:      'neutral',
      sectorScores:     {},
    };
  }

  // \u2500\u2500 Step 3 \u2014 Holdings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  onProgress(3, 'Loading fund holdings...');

  const holdingsMap = {};
  for (const fund of scorableFunds) {
    try {
      holdingsMap[fund.ticker] = await edgarPromiseMap[fund.ticker];
    } catch {
      holdingsMap[fund.ticker] = [];
    }
  }
  // MM funds get empty holdings
  for (const fund of mmFunds) {
    holdingsMap[fund.ticker] = [];
  }

  // Attach holdings to every fund object (mutate working copies)
  const fundsWithHoldings = funds.map(f => ({
    ...f,
    holdings: holdingsMap[f.ticker] ?? [],
  }));

  const scorableFundsWithHoldings = fundsWithHoldings.filter(
    f => !MONEY_MARKET_FUNDS.has(f.ticker)
  );

  // \u2500\u2500 Step 4 \u2014 Tiingo \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Tiingo calls go to the Tiingo REST API (not Claude) \u2014 parallel is safe here.
  onProgress(4, 'Fetching price metrics...');

  const tiingoResults = {};
  if (isEnabled(dataSourcePrefs, 'tiingo')) {
    const riskFreeRate = worldData.fredData?.DFF?.value ?? 0;
    const riskFreeDecimal = riskFreeRate > 1 ? riskFreeRate / 100 : riskFreeRate;

    const tiingoPromises = scorableFunds.map(async fund => {
      try {
        const metrics = await fetchTiingoMetrics(fund.ticker, riskFreeDecimal);
        tiingoResults[fund.ticker] = metrics;
      } catch (err) {
        errors.push(`Tiingo fetch failed for ${fund.ticker}: ${err.message}`);
        tiingoResults[fund.ticker] = null;
      }
    });
    await Promise.all(tiingoPromises);
  }
  // If tiingo disabled, tiingoResults stays {} \u2192 null passed to scoring \u2192 5.0 fallback

  // \u2500\u2500 Step 5 \u2014 Expenses \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  // !! expenses.js no longer calls Claude -- uses Finnhub + static map. !!
  // !! Parallel is safe here. Same pattern as Tiingo (Step 4).          !!
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  onProgress(5, 'Analyzing expense ratios...');

  // Expenses now use Finnhub + Supabase cache (no Claude calls) — parallel is safe.
  const expenseResults = {};
  if (isEnabled(dataSourcePrefs, 'expenses')) {
    const expensePromises = scorableFundsWithHoldings.map(async fund => {
      try {
        const result = await fetchExpenseData(fund.ticker, fund.name, fund.holdings);
        expenseResults[fund.ticker] = result;
      } catch (err) {
        errors.push(`Expense fetch failed for ${fund.ticker}: ${err.message}`);
        expenseResults[fund.ticker] = null;
      }
    });
    await Promise.all(expensePromises);
  }

  // \u2500\u2500 Step 6 \u2014 Manager Scores \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  onProgress(6, 'Evaluating fund managers...');

  const managerScores = await managerPromise;

  // \u2500\u2500 Step 7 \u2014 Mandate Scoring \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  onProgress(7, 'Scoring mandate alignment...');

  let mandateResult = { scores: {}, coverage: 0, acceptable: true };
  if (isEnabled(dataSourcePrefs, 'mandate')) {
    try {
      mandateResult = await scoreMandates(scorableFundsWithHoldings, filteredWorldData);
      if (mandateResult.acceptable === false) {
        throw new Error(
          `Mandate coverage ${Math.round(mandateResult.coverage * 100)}% is below the 85% threshold. ` +
          `Try re-running or check data availability.`
        );
      }
    } catch (err) {
      // Only re-throw if it's the coverage threshold failure
      if (err.message.includes('below the 85% threshold')) {
        throw err;
      }
      errors.push(`Mandate scoring failed: ${err.message}`);
      mandateResult = { scores: {}, coverage: 0, acceptable: true };
    }
  }

  // \u2500\u2500 Step 8 \u2014 Composite Scores \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  onProgress(8, 'Computing final scores...');

  const aggregateDataQuality = {};
  const scoredFunds = fundsWithHoldings.map(fund => {
    const ticker = fund.ticker;

    const mandateScore  = mandateResult.scores[ticker]?.score  ?? null;
    const tiingoMetrics = tiingoResults[ticker]                ?? null;
    const managerScore  = managerScores[ticker]?.score         ?? null;
    const expenseResult = expenseResults[ticker]               ?? null;

    const { composite, breakdown, dataQuality } = calcCompositeScore({
      ticker,
      mandateScore,
      tiingoMetrics,
      managerScore,
      expenseResult,
      holdings: fund.holdings,
      weights,
    });

    // Aggregate dataQuality flags across all funds
    for (const [flag, isSet] of Object.entries(dataQuality)) {
      if (isSet) aggregateDataQuality[flag] = true;
    }

    return {
      ticker,
      name:              fund.name,
      composite,
      breakdown,
      dataQuality,
      holdings:          fund.holdings,
      mandateReasoning:  mandateResult.scores[ticker]?.reasoning   ?? null,
      managerReasoning:  managerScores[ticker]?.reasoning          ?? null,
    };
  });

  // Sort by composite score descending
  scoredFunds.sort((a, b) => b.composite - a.composite);

  // ── Step 9 — Outlier Detection & Allocation ─────────────────────────────
  // Pure math — no API calls. Computes Modified Z-Scores, applies median
  // quality gate + data confidence gate, then exponential allocation curve.
  onProgress(9, 'Detecting outliers & computing allocation...');

  const enrichedFunds = computeOutliersAndAllocation(scoredFunds, riskTolerance);

  // ── Step 10 — Save History ──────────────────────────────────────────────
  onProgress(10, 'Saving results...');

  // Fire and forget \u2014 do NOT await
  saveRunHistory(userId, {
    dominantTheme: thesisResult.dominantTheme,
    macroStance:   thesisResult.macroStance,
    fundScores:    enrichedFunds.map(f => ({ ticker: f.ticker, composite: f.composite, allocPct: f.allocPct })),
    sectorScores:  thesisResult.sectorScores,
  }).catch(err => {
    console.warn('pipeline.js: saveRunHistory failed (non-fatal):', err.message);
  });

  // \u2500\u2500 Return \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  return {
    funds:         enrichedFunds,
    worldData:     {
      fredData:     worldData.fredData,
      headlines:    worldData.headlines,
      treasuryData: worldData.treasuryData,
      fetchedAt:    worldData.fetchedAt,
    },
    thesisResult,
    mandateScores:  mandateResult.scores,
    managerScores,
    expenseRatios:  expenseResults,
    dataQuality:    aggregateDataQuality,
    errors,
  };
}
