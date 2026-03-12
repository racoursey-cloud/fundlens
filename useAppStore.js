import { create } from 'zustand';
import { DEFAULT_WEIGHTS } from '../engine/constants.js';

// Phase 1: auth + UI state only.
// Pipeline state (funds, loading, worldData, etc.) wired in Phase 2.
export const useAppStore = create((set, get) => ({
  // ── Auth ──────────────────────────────────────────────────────
  user:        null,
  profile:     null,
  userFunds:   [],     // [{id, user_id, ticker, name, sort_order}]
  userWeights: null,   // {mandate_score, momentum, risk_adj, manager_quality, risk_tolerance}

  // ── UI ────────────────────────────────────────────────────────
  activeTab:    'rank',
  selectedFund: null,

  // ── Pipeline (Phase 2) ────────────────────────────────────────
  funds:          [],
  loading:        false,
  pipelineStep:   0,
  pipelineDetail: '',
  errors:         [],
  source:         'seed',
  lastRun:        null,
  worldData:      null,
  worldDataFetchedAt: null,
  sectorScores:   null,
  investmentThesis: null,
  dominantTheme:  null,
  managerScores:  {},
  mandateScores:  {},
  expenseRatios:  {},
  holdingsCache:  {},
  sectorMappingCache: {},
  tiingoCache:    {},
  tiingoStale:    false,
  marketOpen:     false,
  prevFundScores: {},
  prevSectorScores: null,
  prevRunAt:      null,
  prevINDPRO:     null,
  investorLetter: null,
  dataQuality:    null,

  // ── Auth actions ──────────────────────────────────────────────
  setUser:        (user)        => set({ user }),
  setProfile:     (profile)     => set({ profile }),
  setUserFunds:   (userFunds)   => set({ userFunds }),
  setUserWeights: (userWeights) => set({ userWeights }),

  // ── UI actions ────────────────────────────────────────────────
  setTab:        (activeTab)    => set({ activeTab }),
  selectFund:    (ticker)       => set({ selectedFund: ticker }),

  // Helper: active weights as the engine's {mandateScore, momentum, riskAdj, managerQuality} shape
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

  getRiskTolerance: () => get().userWeights?.risk_tolerance ?? 5,
}));
