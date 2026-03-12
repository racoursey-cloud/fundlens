import { create } from 'zustand';
import { DEFAULT_WEIGHTS } from '../engine/constants.js';

export const useAppStore = create((set, get) => ({
  user: null, profile: null, userFunds: [], userWeights: null,
  activeTab: 'rank', selectedFund: null,
  funds: [], loading: false, pipelineStep: 0, pipelineDetail: '', errors: [],
  source: 'seed', lastRun: null, worldData: null, worldDataFetchedAt: null,
  sectorScores: null, investmentThesis: null, dominantTheme: null,
  managerScores: {}, mandateScores: {}, expenseRatios: {}, holdingsCache: {},
  sectorMappingCache: {}, tiingoCache: {}, tiingoStale: false, marketOpen: false,
  prevFundScores: {}, prevSectorScores: null, prevRunAt: null, prevINDPRO: null,
  investorLetter: null, dataQuality: null,

  setUser: (user) => set({ user }),
  setProfile: (profile) => set({ profile }),
  setUserFunds: (userFunds) => set({ userFunds }),
  setUserWeights: (userWeights) => set({ userWeights }),
  setTab: (activeTab) => set({ activeTab }),
  selectFund: (ticker) => set({ selectedFund: ticker }),

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
