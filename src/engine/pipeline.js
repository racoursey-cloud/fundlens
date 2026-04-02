// =============================================================================
// FundLens v5.1 — src/engine/pipeline.js
// 11-step scoring pipeline orchestrator.
//
// Steps:
//   1. World Data (FRED, Treasury, GDELT, RSS)
//   2. Investment Thesis (Claude Sonnet)
//   3. Fund Holdings (EDGAR NPORT-P)
//   4. Classify Holdings by Sector (Claude Haiku)
//   5. Price Metrics (Tiingo)
//   6. Holdings Fundamentals (Finnhub)
//   7. Expense Ratios (Supabase cache + static map)
//   8. Composite Scores (pure math, 3-factor + modifiers)
//   9. Outlier Detection & Allocation (Modified Z-Score + exponential curve)
//  10. Investor Letter (Claude Sonnet)
//  11. Save Run History (Supabase)
//
// ⚠️  SEQUENTIAL CLAUDE CALL DISCIPLINE — MANDATORY  ⚠️
// All Claude API calls in engine files MUST be sequential with 1.2s delays.
// Never use Promise.all() for Claude calls. This has broken production 5+ times.
//
// Rules:
//   - No localStorage.
//   - No web_search tool in Claude calls.
//   - All Claude calls route through callClaude() → /api/claude.
//   - All Supabase calls route through supaFetch() via cache.js / api.js.
//   - Every step wrapped in try/catch — partial results flow forward.
// =============================================================================

// Engine files
import { fetchWorldData }           from './world.js';
import { generateThesis }           from './thesis.js';
import { fetchAllHoldings }         from './edgar.js';
import { classifyHoldingSectors }   from './classify.js';
import { fetchTiingoMetrics }       from './tiingo.js';
import { computeHoldingsQuality }   from './quality.js';
import { calcCompositeScores }      from './scoring.js';
import { computeAllocations }       from './outlier.js';
import { generateInvestorLetter }   from './letter.js';

// Services
import { getExpenseRatios, saveRunHistory } from '../services/cache.js';

// Constants
import { STATIC_EXPENSE_MAP } from './constants.js';

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full 11-step FundLens scoring pipeline.
 *
 * @param {string}   userId      - Supabase user ID
 * @param {Array}    userFunds   - [{ ticker, name }, ...] from user's saved fund list
 * @param {Object}   userWeights - { sectorAlignment, momentum, holdingsQuality, risk_tolerance }
 * @param {Function} onStep      - (stepNumber: number, detail: string) => void
 * @returns {Object} {
 *   funds, allocations, thesis, sectorScores, worldData,
 *   holdingsMap, investorLetter, dataQuality
 * }
 */
export async function runPipeline(userId, userFunds, userWeights, onStep) {
  const funds   = userFunds;
  const tickers = funds.map(f => (f.ticker || '').toUpperCase());

  // Partial-result accumulators — populated as each step succeeds.
  // If a step fails its try/catch, the accumulator stays at its safe default
  // and subsequent steps receive fallback inputs rather than crashing.
  let worldData      = null;
  let thesisResult   = null;
  let sectorScores   = null;
  let holdingsMap    = {};
  let tiingoData     = {};
  let qualityScores  = {};
  let expenseRatios  = {};
  let scoredFunds    = [];
  let allocations    = [];
  let investorLetter = null;

  try {

    // ── STEP 1 — World Data ──────────────────────────────────────────────────
    onStep(1, 'Fetching economic data...');
    try {
      worldData = await fetchWorldData(userId, detail => onStep(1, detail));
    } catch (err) {
      console.error('[pipeline] Step 1 (world data) failed:', err?.message);
      worldData = {
        fred:       {},
        treasury:   null,
        gold:       null,
        headlines:  [],
        dataQuality: { worldFallback: true },
      };
    }

    // ── STEP 2 — Thesis ──────────────────────────────────────────────────────
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
    onStep(3, 'Loading fund holdings...');
    try {
      holdingsMap = await fetchAllHoldings(tickers, detail => onStep(3, detail));
    } catch (err) {
      console.error('[pipeline] Step 3 (holdings) failed:', err?.message);
      holdingsMap = {};
    }

    // ── STEP 4 — Classify Holdings by Sector ─────────────────────────────────
    // classify.js mutates holdingsMap in-place, enriching holdings with sectors.
    // It consumes the full { TICKER: { holdings, meta } } shape.
    onStep(4, 'Classifying holdings by sector...');
    try {
      holdingsMap = await classifyHoldingSectors(holdingsMap, detail => onStep(4, detail));
    } catch (err) {
      console.error('[pipeline] Step 4 (classify) failed:', err?.message);
      // holdingsMap unchanged — sectors stay null, alignment falls back to 5.0
    }

    // ── STEP 5 — Tiingo Price Metrics ────────────────────────────────────────
    onStep(5, 'Fetching price metrics...');
    try {
      tiingoData = await fetchTiingoMetrics(tickers, detail => onStep(5, detail));
    } catch (err) {
      console.error('[pipeline] Step 5 (tiingo) failed:', err?.message);
      tiingoData = {};
    }

    // ── STEP 6 — Holdings Fundamentals (Finnhub) ─────────────────────────────
    // quality.js consumes the full { TICKER: { holdings, meta } } shape.
    onStep(6, 'Fetching holdings fundamentals...');
    try {
      qualityScores = await computeHoldingsQuality(holdingsMap, detail => onStep(6, detail));
    } catch (err) {
      console.error('[pipeline] Step 6 (quality) failed:', err?.message);
      qualityScores = {};
    }

    // ── STEP 7 — Expense Ratios (inline) ─────────────────────────────────────
    // Priority: Supabase fund_profiles (90-day TTL) → STATIC_EXPENSE_MAP fallback.
    // No expenses.js import — v4 file is incompatible.
    onStep(7, 'Analyzing expense ratios...');
    try {
      const cached = await getExpenseRatios(tickers);
      expenseRatios = { ...cached };

      for (const ticker of tickers) {
        if (!expenseRatios[ticker] && STATIC_EXPENSE_MAP[ticker]) {
          expenseRatios[ticker] = STATIC_EXPENSE_MAP[ticker];
        }
      }
    } catch (err) {
      console.error('[pipeline] Step 7 (expenses) failed:', err?.message);
      expenseRatios = {};
      for (const ticker of tickers) {
        if (STATIC_EXPENSE_MAP[ticker]) {
          expenseRatios[ticker] = STATIC_EXPENSE_MAP[ticker];
        }
      }
    }

    // ── DATA TRANSFORMS (between steps 7 and 8) ─────────────────────────────
    // These fix interface mismatches between engine files.
    // classify.js and quality.js both consume the full { holdings, meta } shape.
    // Only scoring.js needs the flat versions. Split AFTER classify and quality.

    // Transform 1: edgar output → scoring.js inputs
    // scoring.js param 5 (holdingsMap) expects { TICKER: [holdings_array] }
    // scoring.js param 7 (edgarMeta) expects { TICKER: { netFlows, ... } }
    const holdingsFlat = {};
    const edgarMeta    = {};
    for (const [ticker, entry] of Object.entries(holdingsMap)) {
      holdingsFlat[ticker] = entry?.holdings ?? [];
      edgarMeta[ticker]    = entry?.meta ?? null;
    }

    // Transform 2: thesis sectorScores → scoring.js
    // scoring.js line 105 does Number(sectorScores[sector]) — calling Number()
    // on { score, reason } returns NaN → fallback 5.0. Flatten to { Sector: number }.
    const flatSectorScores = {};
    if (sectorScores) {
      for (const [sector, data] of Object.entries(sectorScores)) {
        flatSectorScores[sector] = typeof data === 'object' ? data.score : data;
      }
    }

    // ── STEP 8 — Composite Scores ────────────────────────────────────────────
    // Pure math — no network calls. 8 parameters in exact order.
    onStep(8, 'Computing composite scores...');
    try {
      scoredFunds = calcCompositeScores(
        funds,              // 1. [{ ticker, name }]
        tiingoData,         // 2. { TICKER: { nav, rawReturn, dailyReturns } }
        qualityScores,      // 3. { TICKER: { score, coverage_pct, ... } }
        expenseRatios,      // 4. { TICKER: { gross, net, note } }
        holdingsFlat,       // 5. { TICKER: [holdings_array] }       ← TRANSFORMED
        flatSectorScores,   // 6. { 'Technology': 7, ... }           ← TRANSFORMED
        edgarMeta,          // 7. { TICKER: { netFlows, ... } }      ← TRANSFORMED
        userWeights         // 8. { sectorAlignment, momentum, holdingsQuality, risk_tolerance }
      );
    } catch (err) {
      console.error('[pipeline] Step 8 (scoring) failed:', err?.message);
      scoredFunds = funds.map(f => ({
        ...f,
        ticker:               (f.ticker || '').toUpperCase(),
        composite:            5.0,
        sectorAlignment:      5.0,
        momentum:             5.0,
        holdingsQuality:      5.0,
        concentrationPenalty: 0,
        expenseModifier:      0,
        flowModifier:         0,
        turnoverModifier:     0,
        sectorBreakdown:      {},
        isMoneyMarket:        false,
        dataQuality: {
          sectorAlignmentFallback:  true,
          momentumFallback:         true,
          holdingsQualityFallback:  true,
          qualityWeightHalved:      false,
          fallbackCount:            3,
        },
      }));
    }

    // ── STEP 9 — Outlier Detection & Allocation ──────────────────────────────
    // Modified Z-Score → quality gates → exponential allocation → 30% cap.
    onStep(9, 'Detecting outliers & computing allocation...');
    try {
      allocations = computeAllocations(
        scoredFunds,
        userWeights.risk_tolerance ?? 5
      );
    } catch (err) {
      console.error('[pipeline] Step 9 (outliers) failed:', err?.message);
      allocations = scoredFunds.map(f => ({
        ticker:         f.ticker,
        allocation_pct: 0,
        tier:           'NEUTRAL',
        modZ:           0,
        composite:      f.composite,
      }));
    }

    // ── STEP 10 — Investor Letter ────────────────────────────────────────────
    // letter.js expects: scoredFunds (sorted array), allocations (outlier output),
    // thesis (STRING), sectorScores (original { Sector: { score, reason } } shape).
    onStep(10, 'Generating investor letter...');
    try {
      const letterResult = await generateInvestorLetter(
        scoredFunds,
        allocations,
        thesisResult?.thesis ?? null,    // pass the string, NOT the full object
        sectorScores,                     // original shape with reasons
        detail => onStep(10, detail)
      );
      investorLetter = letterResult?.letter ?? null;
    } catch (err) {
      console.error('[pipeline] Step 10 (letter) failed:', err?.message);
      investorLetter = null;
    }

    // ── STEP 11 — Save Run History ───────────────────────────────────────────
    // Non-fatal — a save failure must not prevent the UI from receiving results.
    onStep(11, 'Saving results...');
    try {
      // Build allocation lookup for merge and save
      const allocLookup = {};
      for (const a of allocations) {
        allocLookup[a.ticker] = a;
      }

      // fundScores: per-fund scoring detail for run_history
      const fundScores = {};
      for (const f of scoredFunds) {
        fundScores[f.ticker] = {
          composite:       f.composite,
          sectorAlignment: f.sectorAlignment,
          momentum:        f.momentum,
          holdingsQuality: f.holdingsQuality,
          modZ:            allocLookup[f.ticker]?.modZ ?? 0,
          tier:            allocLookup[f.ticker]?.tier ?? 'NEUTRAL',
          dataQuality:     f.dataQuality,
        };
      }

      // allocationMap: { TICKER: decimal_pct }
      const allocationMap = {};
      for (const a of allocations) {
        allocationMap[a.ticker] = a.allocation_pct;
      }

      await saveRunHistory({
        user_id:         userId,
        dominant_theme:  thesisResult?.dominantTheme  ?? null,
        macro_stance:    thesisResult?.macroStance     ?? null,
        quarter_outlook: thesisResult?.quarterOutlook  ?? null,
        thesis_text:     thesisResult?.thesis           ?? null,
        investor_letter: investorLetter                 ?? null,
        fund_scores:     fundScores,
        sector_scores:   sectorScores ?? {},
        allocation:      allocationMap,
        risk_tolerance:  userWeights.risk_tolerance ?? 5,
        factor_weights: {
          sectorAlignment:  userWeights.sectorAlignment  ?? 40,
          momentum:         userWeights.momentum          ?? 30,
          holdingsQuality:  userWeights.holdingsQuality   ?? 30,
        },
        data_quality: worldData?.dataQuality ?? {},
      });
    } catch (err) {
      console.error('[pipeline] Step 11 (save) failed:', err?.message);
      // Intentionally non-fatal — results still returned below.
    }

  } catch (err) {
    // Outer catch: something unexpected escaped all the inner try/catch blocks.
    console.error('[pipeline] Unhandled pipeline error:', err);
  }

  // ── Merge scored funds with allocation data ───────────────────────────────
  // Downstream consumers (UI) need both scoring detail and allocation on each fund.
  const allocLookup = {};
  for (const a of allocations) {
    allocLookup[a.ticker] = a;
  }

  const mergedFunds = scoredFunds.map(f => ({
    ...f,
    allocation_pct: allocLookup[f.ticker]?.allocation_pct ?? 0,
    modZ:           allocLookup[f.ticker]?.modZ            ?? 0,
    tier:           allocLookup[f.ticker]?.tier             ?? 'NEUTRAL',
  }));

  // ── Return ────────────────────────────────────────────────────────────────
  return {
    funds:           mergedFunds,
    allocations,
    thesis:          thesisResult,
    sectorScores,
    worldData,
    holdingsMap,
    investorLetter,
    dataQuality:     worldData?.dataQuality ?? {},
  };
}
