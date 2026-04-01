// =============================================================================
// FundLens v5 — src/engine/pipeline.js
// 10-step scoring pipeline orchestrator.
//
// ⚠️  SEQUENTIAL CLAUDE CALLS — MANDATORY — DO NOT CHANGE
// mandate.js and manager.js use sequential for-loops with 1.2s delays.
// Promise.all() on Claude calls has crashed production 5+ times.
// Never introduce concurrency for Claude API calls in any engine file.
// =============================================================================

import { fetchWorldData }               from './world.js';
import { generateThesis }               from './thesis.js';
import { fetchAllHoldings }             from './edgar.js';
import { fetchTiingoMetrics }           from './tiingo.js';
import { scoreManagers }                from './manager.js';
import { scoreMandates }                from './mandate.js';
import { calcCompositeScores }          from './scoring.js';
import { computeOutliersAndAllocation } from './outlier.js';
import {
  getExpenseRatios,
  saveRunHistory,
} from '../services/cache.js';
import { STATIC_EXPENSE_MAP }           from './constants.js';

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full 10-step FundLens scoring pipeline.
 *
 * @param {string}   userId      - Supabase user ID
 * @param {Array}    userFunds   - [{ ticker, name }, ...] from user's saved fund list
 * @param {Object}   userWeights - { mandateScore, momentum, riskAdj, managerQuality, risk_tolerance }
 * @param {Function} onStep      - (stepNumber: number, detail: string) => void
 * @returns {Object} {
 *   funds, thesis, sectorScores, worldData,
 *   holdingsMap, mandateScores, managerScores, dataQuality
 * }
 */
export async function runPipeline(userId, userFunds, userWeights, onStep) {
  const funds   = userFunds;
  const tickers = funds.map(f => (f.ticker || '').toUpperCase());

  // Partial-result accumulators — populated as each step succeeds.
  // If a step fails its try/catch, the accumulator stays at its safe default
  // and subsequent steps receive fallback inputs rather than crashing.
  let worldData     = null;
  let thesisResult  = null;
  let sectorScores  = null;
  let holdingsMap   = {};
  let tiingoData    = {};
  let expenseRatios = {};
  let managerScores = {};
  let mandateScores = {};
  let scoredFunds   = [];
  let finalFunds    = [];

  try {

    // ── BACKGROUND — fire immediately, await at designated steps ────────────
    //
    // scoreManagers uses sequential Claude calls internally (mandatory).
    // fetchAllHoldings hits EDGAR — network-bound, safe to start early.
    // Errors in either are caught here so the pipeline doesn't crash.
    const managerPromise = scoreManagers(funds).catch(err => {
      console.warn('[pipeline] manager background task failed:', err?.message);
      return {};
    });

    const holdingsPromise = fetchAllHoldings(tickers).catch(err => {
      console.warn('[pipeline] holdings background task failed:', err?.message);
      return {};
    });

    // ── STEP 1 — World Data ──────────────────────────────────────────────────
    // fetchWorldData calls FRED, Treasury, and GDELT sequentially and caches
    // the result. onStep(1, detail) is called internally for sub-step progress.
    try {
      worldData = await fetchWorldData(userId, detail => onStep(1, detail));
    } catch (err) {
      console.error('[pipeline] Step 1 (world data) failed:', err?.message);
      worldData = {
        fredData:    {},
        headlines:   [],
        treasuryData: {},
        dataQuality:  { worldFallback: true },
      };
    }

    // ── STEP 2 — Thesis ──────────────────────────────────────────────────────
    // generateThesis calls Claude (sequential, 1 call). Returns sectorScores
    // which flow into mandate scoring and the UI Thesis tab.
    onStep(2, 'Generating investment thesis...');
    try {
      thesisResult = await generateThesis(worldData);
      sectorScores = thesisResult?.sectorScores ?? null;
    } catch (err) {
      console.error('[pipeline] Step 2 (thesis) failed:', err?.message);
      thesisResult = null;
      sectorScores = null;
    }

    // ── STEP 3 — Holdings ────────────────────────────────────────────────────
    // Await the background holdings fetch started before Step 1.
    onStep(3, 'Resolving fund holdings...');
    try {
      holdingsMap = await holdingsPromise;
    } catch (err) {
      console.error('[pipeline] Step 3 (holdings) failed:', err?.message);
      holdingsMap = {};
    }

    // ── STEP 4 — Tiingo Metrics ──────────────────────────────────────────────
    // fetchTiingoMetrics fetches momentum (63-day) and Sharpe for each ticker.
    // onStep(4, detail) is called internally for per-ticker progress.
    try {
      tiingoData = await fetchTiingoMetrics(tickers, detail => onStep(4, detail));
    } catch (err) {
      console.error('[pipeline] Step 4 (tiingo) failed:', err?.message);
      tiingoData = {};
    }

    // ── STEP 5 — Expenses ────────────────────────────────────────────────────
    // Priority: Supabase cache (90-day TTL) → STATIC_EXPENSE_MAP fallback.
    // Finnhub live fetch (for uncached tickers) is handled inside expenses.js
    // which also writes new rows back to fund_profiles via saveExpenseRatios().
    onStep(5, 'Analyzing expense ratios...');
    try {
      const cached = await getExpenseRatios(tickers);

      // Start with whatever the cache returned.
      expenseRatios = { ...cached };

      // Fill any gaps from the static map.
      for (const ticker of tickers) {
        if (!expenseRatios[ticker] && STATIC_EXPENSE_MAP[ticker]) {
          expenseRatios[ticker] = STATIC_EXPENSE_MAP[ticker];
        }
      }
    } catch (err) {
      console.error('[pipeline] Step 5 (expenses) failed:', err?.message);
      // Fall back entirely to static map so scoring.js still has data.
      expenseRatios = {};
      for (const ticker of tickers) {
        if (STATIC_EXPENSE_MAP[ticker]) {
          expenseRatios[ticker] = STATIC_EXPENSE_MAP[ticker];
        }
      }
    }

    // ── STEP 6 — Managers ────────────────────────────────────────────────────
    // Await the background manager scoring started before Step 1.
    // manager.js uses sequential Claude calls — already enforced there.
    onStep(6, 'Awaiting manager scores...');
    try {
      managerScores = await managerPromise;
    } catch (err) {
      console.error('[pipeline] Step 6 (managers) failed:', err?.message);
      managerScores = {};
    }

    // ── STEP 7 — Mandates ────────────────────────────────────────────────────
    // mandate.js scores each fund against the current macro environment.
    // Sequential Claude calls with 1.2s delays — mandatory, do not parallelize.
    // onStep(7, detail) is called per-fund for progress granularity.
    try {
      mandateScores = await scoreMandates(
        funds,
        worldData,
        sectorScores,
        detail => onStep(7, detail)
      );
    } catch (err) {
      console.error('[pipeline] Step 7 (mandates) failed:', err?.message);
      mandateScores = {};
    }

    // ── STEP 8 — Composite Scores ────────────────────────────────────────────
    // Pure math — no network calls. Combines all sub-scores into a single
    // composite value per fund with HHI concentration penalty and expense modifier.
    onStep(8, 'Computing final scores...');
    try {
      scoredFunds = calcCompositeScores(
        funds,
        mandateScores,
        tiingoData,
        managerScores,
        expenseRatios,
        holdingsMap,
        sectorScores,
        userWeights
      );
    } catch (err) {
      console.error('[pipeline] Step 8 (scoring) failed:', err?.message);
      // Produce a safe all-5.0 fallback array so Step 9 still runs.
      scoredFunds = funds.map(f => ({
        ...f,
        ticker:               (f.ticker || '').toUpperCase(),
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
        isMoneyMarket:        false,
        dataQuality: {
          mandateFallback:  true,
          momentumFallback: true,
          riskAdjFallback:  true,
          managerFallback:  true,
          fallbackCount:    4,
        },
      }));
    }

    // ── STEP 9 — Outliers + Allocation ───────────────────────────────────────
    // Modified Z-Score → quality gates → exponential allocation → 30% cap.
    onStep(9, 'Detecting outliers & computing allocation...');
    try {
      finalFunds = computeOutliersAndAllocation(
        scoredFunds,
        userWeights.risk_tolerance ?? 5
      );
    } catch (err) {
      console.error('[pipeline] Step 9 (outliers) failed:', err?.message);
      finalFunds = scoredFunds.map(f => ({
        ...f,
        modZ:     0,
        tier:     { label: 'NEUTRAL', color: '#6b7280', description: 'In line with peers' },
        allocPct: 0,
      }));
    }

    // ── STEP 10 — Save ───────────────────────────────────────────────────────
    // Persist results to run_history so the UI can load them on next visit.
    // Non-fatal — a save failure must not prevent the UI from receiving results.
    onStep(10, 'Saving results...');
    try {
      const allocation  = {};
      const fundScores  = {};

      for (const f of finalFunds) {
        allocation[f.ticker] = f.allocPct;

        fundScores[f.ticker] = {
          composite:      f.composite,
          mandateScore:   f.mandateScore,
          momentum:       f.momentum,
          riskAdj:        f.riskAdj,
          managerQuality: f.managerQuality,
          modZ:           f.modZ,
          tier:           f.tier,
          dataQuality:    f.dataQuality,
        };
      }

      await saveRunHistory({
        user_id:         userId,
        dominant_theme:  thesisResult?.dominantTheme  ?? null,
        macro_stance:    thesisResult?.macroStance     ?? null,
        quarter_outlook: thesisResult?.quarterOutlook  ?? null,
        thesis_text:     thesisResult?.thesisText      ?? null,
        investor_letter: thesisResult?.investorLetter  ?? null,
        fund_scores:     fundScores,
        sector_scores:   sectorScores ?? {},
        allocation,
        risk_tolerance:  userWeights.risk_tolerance ?? 5,
        factor_weights: {
          mandateScore:   userWeights.mandateScore   ?? 40,
          momentum:       userWeights.momentum        ?? 25,
          riskAdj:        userWeights.riskAdj         ?? 20,
          managerQuality: userWeights.managerQuality  ?? 15,
        },
        data_quality: worldData?.dataQuality ?? {},
      });
    } catch (err) {
      console.error('[pipeline] Step 10 (save) failed:', err?.message);
      // Intentionally non-fatal — results still returned below.
    }

  } catch (err) {
    // Outer catch: something unexpected escaped all the inner try/catch blocks.
    console.error('[pipeline] Unhandled pipeline error:', err);
  }

  // ── Return ────────────────────────────────────────────────────────────────
  // Prefer finalFunds (post-allocation); fall back to scoredFunds if Step 9
  // never ran (e.g., Step 8 produced an empty array).
  return {
    funds:         finalFunds.length > 0 ? finalFunds : scoredFunds,
    thesis:        thesisResult,
    sectorScores,
    worldData,
    holdingsMap,
    mandateScores,
    managerScores,
    dataQuality:   worldData?.dataQuality ?? {},
  };
}
