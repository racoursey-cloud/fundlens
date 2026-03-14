import { create } from 'zustand';
import { DEFAULT_WEIGHTS, MONEY_MARKET_FUNDS } from '../engine/constants.js';
import { runPipeline as runPipelineEngine }    from '../engine/pipeline.js';
import { computeOutliersAndAllocation }        from '../engine/outlier.js';

export const useAppStore = create((set, get) => ({
  // ── Existing state (unchanged) ──────────────────────────────────────────────
  user: null, profile: null, userFunds: [], userWeights: null,
  activeTab: 'rank', selectedFund: null,
  funds: [], loading: false, pipelineStep: 0, pipelineDetail: '', errors: [],
  source: 'seed', lastRun: null, worldData: null, worldDataFetchedAt: null,
  sectorScores: null, investmentThesis: null, dominantTheme: null,
  managerScores: {}, mandateScores: {}, expenseRatios: {}, holdingsCache: {},
  sectorMappingCache: {}, tiingoCache: {}, tiingoStale: false, marketOpen: false,
  prevFundScores: {}, prevSectorScores: null, prevRunAt: null, prevINDPRO: null,
  investorLetter: null, dataQuality: null,

  // ── New state ───────────────────────────────────────────────────────────────
  macroStance:     null,   // 'risk-on' | 'risk-off' | 'neutral' from thesis
  thesisResult:    null,   // full thesisResult object from pipeline
  dataSourcePrefs: {},     // empty object = all sources enabled by default

  // ── Existing actions (unchanged) ────────────────────────────────────────────
  setUser:        (user)        => set({ user }),
  setProfile:     (profile)     => set({ profile }),
  setUserFunds:   (userFunds)   => set({ userFunds }),
  setUserWeights: (userWeights) => set({ userWeights }),
  setTab:         (activeTab)   => set({ activeTab }),
  selectFund:     (ticker)      => set({ selectedFund: ticker }),

  // Maps snake_case DB columns → camelCase weight keys. Do not modify.
  getWeights: () => {
    const w = get().userWeights;
    if (!w) return DEFAULT_WEIGHTS;
    return {
      mandateScore:   w.mandate_score   ?? DEFAULT_WEIGHTS.mandateScore,
      momentum:       w.momentum        ?? DEFAULT_WEIGHTS.momentum,
      riskAdj:        w.risk_adj        ?? DEFAULT_WEIGHTS.riskAdj,
      managerQuality: w.manager_quality ?? DEFAULT_WEIGHTS.managerQuality,
    };
  },

  // Do not modify.
  getRiskTolerance: () => get().userWeights?.risk_tolerance ?? 5,

  // ── New actions ─────────────────────────────────────────────────────────────

  /**
   * Run the full scoring pipeline and populate store from results.
   * Pulls funds, weights, userId, and dataSourcePrefs from current state.
   * The onProgress callback drives the loading-step UI.
   */
  runPipeline: async () => {
    const state          = get();
    const funds          = state.userFunds;
    const weights        = state.getWeights();
    const userId         = state.user?.id;
    const dataSourcePrefs = state.dataSourcePrefs;
    const riskTolerance  = state.getRiskTolerance();

    set({ loading: true, pipelineStep: 0, pipelineDetail: '', errors: [] });

    try {
      const result = await runPipelineEngine(
        funds,
        weights,
        userId,
        dataSourcePrefs,
        (step, detail) => set({ pipelineStep: step, pipelineDetail: detail }),
        riskTolerance,
      );

      set({
        funds:            result.funds,
        worldData:        result.worldData,
        thesisResult:     result.thesisResult,
        investmentThesis: result.thesisResult?.investmentThesis ?? null,
        dominantTheme:    result.thesisResult?.dominantTheme    ?? null,
        macroStance:      result.thesisResult?.macroStance      ?? null,
        sectorScores:     result.thesisResult?.sectorScores     ?? null,
        mandateScores:    result.mandateScores,
        managerScores:    result.managerScores,
        expenseRatios:    result.expenseRatios,
        dataQuality:      result.dataQuality,
        source:           'live',
        lastRun:          new Date().toISOString(),
        loading:          false,
        errors:           result.errors ?? [],
      });
    } catch (err) {
      set({ errors: [err.message], loading: false });
    }
  },

  /**
   * Re-score all funds with new weights — pure math, no API calls.
   * Uses fund.breakdown sub-scores (already normalised 1–10) from the last
   * pipeline run. Skips money market funds (fixed 5.0). Re-sorts by composite.
   * Updates userWeights in state so getWeights() reflects the new values.
   *
   * @param {{ mandateScore: number, momentum: number, riskAdj: number, managerQuality: number }} newWeights
   * @param {number} [newRiskTolerance] — optional; if provided, updates risk tolerance before rescoring
   */
  rescoreWithWeights: (newWeights, newRiskTolerance) => {
    const { funds } = get();
    if (!funds?.length) return;

    // Normalise new weights to fractions (handles any non-100 sum gracefully)
    const total = (newWeights.mandateScore   ?? 40)
                + (newWeights.momentum       ?? 25)
                + (newWeights.riskAdj        ?? 20)
                + (newWeights.managerQuality ?? 15);

    const W = {
      mandate:  (newWeights.mandateScore   ?? 40) / total,
      momentum: (newWeights.momentum       ?? 25) / total,
      riskAdj:  (newWeights.riskAdj        ?? 20) / total,
      manager:  (newWeights.managerQuality ?? 15) / total,
    };

    const updatedFunds = funds.map(fund => {
      // Money market funds stay fixed at 5.0
      if (MONEY_MARKET_FUNDS.has(fund.ticker)) return fund;

      const b = fund.breakdown;
      if (!b) return fund; // guard: no breakdown data, leave unchanged

      const raw = (b.mandateScore   * W.mandate)
                + (b.momentum       * W.momentum)
                + (b.riskAdj        * W.riskAdj)
                + (b.managerQuality * W.manager);

      const modified  = raw - b.concentrationPenalty + b.expenseModifier;
      const composite = Math.round(Math.max(1.0, Math.min(10.0, modified)) * 10) / 10;

      return { ...fund, composite };
    });

    // Re-sort by composite descending
    updatedFunds.sort((a, b) => b.composite - a.composite);

    // Re-run outlier detection + allocation with new composites
    const riskTolerance = newRiskTolerance ?? get().getRiskTolerance();
    const enrichedFunds = computeOutliersAndAllocation(updatedFunds, riskTolerance);

    // Merge new weights into userWeights using the DB snake_case keys so
    // getWeights() continues to work correctly on next read.
    const mergedWeights = {
      ...get().userWeights,
      mandate_score:   newWeights.mandateScore,
      momentum:        newWeights.momentum,
      risk_adj:        newWeights.riskAdj,
      manager_quality: newWeights.managerQuality,
    };
    // Persist risk tolerance if explicitly provided
    if (newRiskTolerance != null) {
      mergedWeights.risk_tolerance = newRiskTolerance;
    }
    set({
      funds: enrichedFunds,
      userWeights: mergedWeights,
    });
  },

  /**
   * Update data-source toggle preferences and persist to Supabase profiles.
   * Fire-and-forget — a persist failure is logged but does not surface to UI.
   *
   * @param {Object} prefs  — { [sourceKey]: boolean }
   */
  setDataSourcePrefs: (prefs) => {
    set({ dataSourcePrefs: prefs });

    const userId = get().user?.id;
    if (!userId) return;

    // Persist to profiles.data_source_prefs via the Railway /api/supabase proxy.
    // supaFetch() is not exported from cache.js, so we mirror its fetch pattern here.
    fetch(`/api/supabase/profiles?user_id=eq.${encodeURIComponent(userId)}`, {
      method:  'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Prefer':       'return=minimal',
      },
      body: JSON.stringify({ data_source_prefs: prefs }),
    }).catch(err => {
      console.warn('useAppStore: setDataSourcePrefs persist failed (non-fatal):', err.message);
    });
  },

  /** Clear the errors array (e.g. when the user dismisses an error banner). */
  clearErrors: () => set({ errors: [] }),
}));
