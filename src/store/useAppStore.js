// =============================================================================
// FundLens v5 — src/store/useAppStore.js
// Central Zustand state store. All components read from here; all mutations
// go through actions defined here. No component should call pipeline, cache,
// or supaFetch directly.
//
// ⚠️  SEQUENTIAL CLAUDE CALLS — MANDATORY — DO NOT CHANGE
// runPipeline() internally calls mandate.js and manager.js which use
// sequential for-loops with 1.2s delays. Never wrap runPipeline in
// Promise.all() or introduce concurrency around Claude calls.
// =============================================================================

import { create } from 'zustand';

import { runPipeline }                  from '../engine/pipeline.js';
import { calcCompositeScores }          from '../engine/scoring.js';
import { computeOutliersAndAllocation } from '../engine/outlier.js';
import * as cache                       from '../services/cache.js';
import { supaFetch }                    from '../services/api.js';
import {
  DEFAULT_WEIGHTS,
  SEED_SCORES,
  FACTOR_KEYS,
  DEFAULT_FUNDS,
  MONEY_MARKET_TICKERS,
} from '../engine/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the initial seed fund array by merging a list of { ticker, name }
 * objects with SEED_SCORES defaults. If a ticker has no entry in SEED_SCORES
 * (e.g. a fund the user added manually), we default all sub-scores to 5.0.
 */
function buildSeedFunds(fundList) {
  return fundList.map(f => {
    const ticker = (f.ticker || '').toUpperCase();
    const seed   = SEED_SCORES[ticker] ?? {
      composite:      5.0,
      mandateScore:   5.0,
      momentum:       5.0,
      riskAdj:        5.0,
      managerQuality: 5.0,
    };

    return {
      ticker,
      name:           f.name ?? f.fund_name ?? ticker,
      sort_order:     f.sort_order ?? 0,
      composite:      seed.composite,
      mandateScore:   seed.mandateScore,
      momentum:       seed.momentum,
      riskAdj:        seed.riskAdj,
      managerQuality: seed.managerQuality,
      modZ:           0,
      allocPct:       0,
      tier:           { label: 'NEUTRAL', color: '#6b7280', description: 'In line with peers' },
      isMoneyMarket:  MONEY_MARKET_TICKERS.has(ticker),
      dataQuality:    {},
    };
  });
}

/**
 * Normalises a user_weights DB row (snake_case columns) to the camelCase
 * shape used throughout the store and engine. Returns DEFAULT_WEIGHTS merged
 * with whatever was found so missing columns stay at their defaults.
 */
function normaliseWeights(row) {
  if (!row) return { ...DEFAULT_WEIGHTS };

  return {
    mandateScore:   row.mandateScore   ?? row.mandate_score   ?? DEFAULT_WEIGHTS.mandateScore,
    momentum:       row.momentum       ?? row.momentum        ?? DEFAULT_WEIGHTS.momentum,
    riskAdj:        row.riskAdj        ?? row.risk_adj        ?? DEFAULT_WEIGHTS.riskAdj,
    managerQuality: row.managerQuality ?? row.manager_quality ?? DEFAULT_WEIGHTS.managerQuality,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useAppStore = create((set, get) => ({

  // ── User ──────────────────────────────────────────────────────────────────
  user:          null,   // Supabase auth user object
  profile:       null,   // profiles table row
  userFunds:     [],     // user_funds rows [{ ticker, name, sort_order }]
  weights:       { ...DEFAULT_WEIGHTS },
  riskTolerance: 5,

  // ── Pipeline results ──────────────────────────────────────────────────────
  funds:          [],    // scored + allocated fund objects — the main data array
  thesis:         null,  // result from generateThesis
  sectorScores:   null,  // { sectorName: score, ... }
  allocation:     [],    // same array as funds, exposed separately for clarity
  worldData:      null,  // raw world data (FRED, GDELT, Treasury)
  holdingsMap:    {},    // ticker → holdings array
  mandateScores:  {},    // ticker → { mandateScore, reasoning }
  managerScores:  {},    // ticker → { score, reasoning }
  investorLetter: null,  // plain-English investor letter (string)
  dataQuality:    null,  // { fredOk, gdeltOk, ... }

  // Private — kept in state so rescoreLocal can call calcCompositeScores
  // without re-fetching. Never read directly by UI components.
  _tiingoData:    {},
  _expenseRatios: {},

  // ── Pipeline state ────────────────────────────────────────────────────────
  isRunning:      false,
  pipelineStep:   0,     // 1–10
  pipelineDetail: '',    // sub-step detail text shown in overlay
  source:         'seed', // 'seed' | 'loading' | 'live'

  // ── UI state ──────────────────────────────────────────────────────────────
  activeTab:      'portfolio', // 'portfolio' | 'thesis' | 'settings'
  selectedFund:   null,        // ticker string | null (drives detail sidebar)

  // ── Data source prefs ─────────────────────────────────────────────────────
  dataSourcePrefs: {},  // { [sourceId]: enabled boolean }

  // =========================================================================
  // ACTIONS
  // =========================================================================

  // ── initUser ──────────────────────────────────────────────────────────────
  /**
   * Called once after Supabase auth resolves. Loads all per-user data and
   * populates the store with seed scores so the UI renders immediately.
   */
  async initUser(user) {
    set({ user });

    const userId = user?.id;
    if (!userId) return;

    try {
      // Fetch in parallel — these are independent reads.
      const [profile, userFundsRaw, weightsRow, sourcesRaw] = await Promise.all([
        cache.getUserProfile(userId).catch(() => null),
        cache.getUserFunds(userId).catch(() => []),
        cache.getUserWeights(userId).catch(() => null),
        cache.getEnabledSources(userId).catch(() => []),
      ]);

      // Normalise weights — DB row may be snake_case or camelCase.
      const weights = normaliseWeights(weightsRow);

      // Risk tolerance lives in the weights row.
      const riskTolerance =
        weightsRow?.risk_tolerance ?? weightsRow?.riskTolerance ?? 5;

      // If the user has no saved funds yet, fall back to DEFAULT_FUNDS.
      const fundList =
        Array.isArray(userFundsRaw) && userFundsRaw.length > 0
          ? userFundsRaw
          : DEFAULT_FUNDS;

      // Build seed-scored fund objects for immediate UI render.
      const funds = buildSeedFunds(fundList);

      // Flatten source prefs into { [sourceId]: enabled }.
      const dataSourcePrefs = {};
      for (const s of sourcesRaw) {
        dataSourcePrefs[s.id] = s.enabled;
      }

      set({
        profile,
        userFunds:      fundList,
        weights,
        riskTolerance,
        funds,
        allocation:     funds,
        dataSourcePrefs,
        source:         'seed',
      });
    } catch (err) {
      console.error('[store] initUser failed:', err?.message);
    }
  },

  // ── setActiveTab ──────────────────────────────────────────────────────────
  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  // ── selectFund ────────────────────────────────────────────────────────────
  /**
   * Opens the fund detail sidebar for `ticker`, or closes it when null.
   */
  selectFund(ticker) {
    set({ selectedFund: ticker ?? null });
  },

  // ── runPipelineAction ─────────────────────────────────────────────────────
  /**
   * Executes the full 10-step scoring pipeline and populates the store with
   * live results. Guards against concurrent runs.
   */
  async runPipelineAction() {
    const { isRunning, user, userFunds, weights, riskTolerance } = get();
    if (isRunning) return;

    const userId = user?.id;
    if (!userId) {
      console.error('[store] runPipelineAction: no authenticated user');
      return;
    }

    // Use the fund list from state; fall back to DEFAULT_FUNDS if empty.
    const fundsToScore =
      Array.isArray(userFunds) && userFunds.length > 0
        ? userFunds
        : DEFAULT_FUNDS;

    set({ isRunning: true, source: 'loading', pipelineStep: 0, pipelineDetail: '' });

    try {
      const result = await runPipeline(
        userId,
        fundsToScore,
        { ...weights, risk_tolerance: riskTolerance },
        (step, detail) => set({ pipelineStep: step, pipelineDetail: detail ?? '' })
      );

      // pipeline.js returns:
      //   { funds, thesis, sectorScores, worldData, holdingsMap,
      //     mandateScores, managerScores, dataQuality }
      //
      // Each fund in result.funds already has modZ, tier, and allocPct
      // because pipeline Step 9 ran computeOutliersAndAllocation.

      // Reconstruct private caches from fund objects so rescoreLocal works.
      const _tiingoData    = {};
      const _expenseRatios = {};

      for (const f of result.funds) {
        const t = f.ticker;
        // Tiingo data is embedded in the fund object after scoring.
        _tiingoData[t] = {
          momentum: f.momentum     ?? null,
          sharpe:   f.sharpe       ?? null,
          riskAdj:  f.riskAdj      ?? null,
          nav:      f.nav          ?? null,
        };
        // Expense ratios can be reconstructed from the fund object if present.
        if (f.expenseGross != null || f.expenseNet != null) {
          _expenseRatios[t] = {
            gross: f.expenseGross ?? null,
            net:   f.expenseNet   ?? null,
          };
        }
      }

      set({
        funds:          result.funds,
        allocation:     result.funds,
        thesis:         result.thesis,
        sectorScores:   result.sectorScores,
        worldData:      result.worldData,
        holdingsMap:    result.holdingsMap    ?? {},
        mandateScores:  result.mandateScores  ?? {},
        managerScores:  result.managerScores  ?? {},
        investorLetter: result.thesis?.investorLetter ?? null,
        dataQuality:    result.dataQuality    ?? {},
        _tiingoData,
        _expenseRatios,
        source:         'live',
        isRunning:      false,
        pipelineStep:   10,
        pipelineDetail: 'Done',
      });
    } catch (err) {
      console.error('[store] runPipelineAction failed:', err?.message ?? err);
      set({ isRunning: false, source: get().funds.length > 0 ? 'live' : 'seed' });
    }
  },

  // ── rescoreLocal ─────────────────────────────────────────────────────────
  /**
   * Pure-math re-rank triggered when factor weight sliders change.
   * Re-uses cached sub-scores — no API calls, no network round-trip.
   *
   * @param {Object} newWeights – { mandateScore, momentum, riskAdj, managerQuality }
   */
  async rescoreLocal(newWeights) {
    const {
      funds, userFunds, holdingsMap, sectorScores, riskTolerance,
      mandateScores, managerScores, _tiingoData, _expenseRatios, user,
    } = get();

    if (!funds || funds.length === 0) return;

    // Merge new weights into state immediately for responsive slider feedback.
    set({ weights: newWeights });

    try {
      // calcCompositeScores expects the raw fund list (ticker + name), not
      // the enriched objects, so we strip back to the minimal shape it needs.
      const fundList = (userFunds.length > 0 ? userFunds : DEFAULT_FUNDS).map(f => ({
        ticker: (f.ticker || '').toUpperCase(),
        name:   f.name ?? f.fund_name ?? f.ticker,
      }));

      const scored = calcCompositeScores(
        fundList,
        mandateScores,
        _tiingoData,
        managerScores,
        _expenseRatios,
        holdingsMap,
        sectorScores,
        { ...newWeights, risk_tolerance: riskTolerance }
      );

      const allocated = computeOutliersAndAllocation(scored, riskTolerance);

      set({ funds: allocated, allocation: allocated });

      // Persist new weights to Supabase asynchronously — non-blocking.
      if (user?.id) {
        cache
          .saveUserWeights(user.id, { ...newWeights, risk_tolerance: riskTolerance })
          .catch(err => console.warn('[store] rescoreLocal — weight save failed:', err?.message));
      }
    } catch (err) {
      console.error('[store] rescoreLocal failed:', err?.message ?? err);
    }
  },

  // ── setRiskTolerance ──────────────────────────────────────────────────────
  /**
   * Updates the risk tolerance slider value and immediately re-runs allocation
   * math (outlier detection + exponential curve) using existing composite scores.
   * No API calls to Claude or Tiingo.
   *
   * @param {number} value  Integer 1–9.
   */
  async setRiskTolerance(value) {
    const { funds, weights, user } = get();

    set({ riskTolerance: value });

    if (funds && funds.length > 0) {
      try {
        const reallocated = computeOutliersAndAllocation(funds, value);
        set({ funds: reallocated, allocation: reallocated });
      } catch (err) {
        console.error('[store] setRiskTolerance — reallocation failed:', err?.message);
      }
    }

    // Persist to Supabase asynchronously.
    if (user?.id) {
      cache
        .saveUserWeights(user.id, { ...weights, risk_tolerance: value })
        .catch(err =>
          console.warn('[store] setRiskTolerance — weight save failed:', err?.message)
        );
    }
  },

  // ── setDataSourcePrefs ────────────────────────────────────────────────────
  /**
   * Applies a patch object of { [sourceId]: enabled } to the current prefs,
   * persisting each changed value to Supabase.
   *
   * @param {Object} newPrefs  Partial or full source prefs map.
   */
  async setDataSourcePrefs(newPrefs) {
    const { dataSourcePrefs, user } = get();

    const merged = { ...dataSourcePrefs, ...newPrefs };
    set({ dataSourcePrefs: merged });

    if (!user?.id) return;

    // Persist only the changed entries to minimise writes.
    for (const [sourceId, enabled] of Object.entries(newPrefs)) {
      if (dataSourcePrefs[sourceId] !== enabled) {
        cache
          .saveUserSourcePref(user.id, sourceId, enabled)
          .catch(err =>
            console.warn('[store] setDataSourcePrefs — save failed:', err?.message, { sourceId })
          );
      }
    }
  },

  // ── updateProfile ─────────────────────────────────────────────────────────
  /**
   * Patches the user's profiles row in Supabase and updates local state.
   *
   * @param {Object} updates  Partial profiles row (e.g. { display_name }).
   */
  async updateProfile(updates) {
    const { user, profile } = get();
    if (!user?.id) return;

    try {
      await supaFetch(`profiles?id=eq.${encodeURIComponent(user.id)}`, {
        method:  'PATCH',
        body:    JSON.stringify(updates),
        headers: { 'Prefer': 'return=representation' },
      });

      set({ profile: { ...profile, ...updates } });
    } catch (err) {
      console.error('[store] updateProfile failed:', err?.message);
    }
  },

  // ── addFund ───────────────────────────────────────────────────────────────
  /**
   * Appends a new fund to the user's fund list in Supabase, then re-fetches
   * the full list to keep sort_order consistent. Also inserts a seed fund
   * object into the local funds array so the UI shows it immediately.
   *
   * @param {string} ticker
   * @param {string} name
   */
  async addFund(ticker, name) {
    const { user, userFunds, funds } = get();
    if (!user?.id) return;

    const upperTicker = (ticker || '').toUpperCase();

    // Guard: don't add duplicates.
    if (userFunds.some(f => (f.ticker || '').toUpperCase() === upperTicker)) return;

    try {
      const nextOrder = userFunds.reduce((max, f) => Math.max(max, f.sort_order ?? 0), 0) + 1;

      await supaFetch('user_funds', {
        method:  'POST',
        body:    JSON.stringify({
          user_id:    user.id,
          ticker:     upperTicker,
          name:       name ?? upperTicker,
          sort_order: nextOrder,
        }),
        headers: { 'Prefer': 'return=representation' },
      });

      // Re-fetch the authoritative list from Supabase.
      const refreshed = await cache.getUserFunds(user.id).catch(() => userFunds);

      // Build a seed fund object for the newly added ticker so the UI has
      // something to render before the next pipeline run.
      const seedEntry = buildSeedFunds([{ ticker: upperTicker, name: name ?? upperTicker }]);
      const updatedFunds = [
        ...funds.filter(f => (f.ticker || '').toUpperCase() !== upperTicker),
        ...seedEntry,
      ];

      set({ userFunds: refreshed, funds: updatedFunds, allocation: updatedFunds });
    } catch (err) {
      console.error('[store] addFund failed:', err?.message);
    }
  },

  // ── removeFund ────────────────────────────────────────────────────────────
  /**
   * Removes a fund from the user's list in Supabase and drops it from the
   * local funds array without requiring a full pipeline re-run.
   *
   * @param {string} ticker
   */
  async removeFund(ticker) {
    const { user, userFunds, funds, selectedFund } = get();
    if (!user?.id) return;

    const upperTicker = (ticker || '').toUpperCase();

    try {
      await supaFetch(
        `user_funds?user_id=eq.${encodeURIComponent(user.id)}&ticker=eq.${encodeURIComponent(upperTicker)}`,
        { method: 'DELETE' }
      );

      // Re-fetch to get clean sort_order values.
      const refreshed = await cache.getUserFunds(user.id).catch(
        () => userFunds.filter(f => (f.ticker || '').toUpperCase() !== upperTicker)
      );

      const updatedFunds = funds.filter(f => (f.ticker || '').toUpperCase() !== upperTicker);

      set({
        userFunds:    refreshed,
        funds:        updatedFunds,
        allocation:   updatedFunds,
        // Close the sidebar if it was showing the removed fund.
        selectedFund: selectedFund === upperTicker ? null : selectedFund,
      });
    } catch (err) {
      console.error('[store] removeFund failed:', err?.message);
    }
  },

}));

export default useAppStore;
