export const DEFAULT_FUNDS = [
  { ticker: 'PRPFX', name: 'Permanent Portfolio I' },
  { ticker: 'WFPRX', name: 'Allspring Special Mid Cap Value' },
  { ticker: 'VFWAX', name: 'Vanguard FTSE All-World ex-US' },
  { ticker: 'QFVRX', name: 'Pear Tree Polaris Foreign Value' },
  { ticker: 'MADFX', name: 'Matrix Advisors Dividend Fund' },
  { ticker: 'VADFX', name: 'Invesco Equal-Weight S&P 500' },
  { ticker: 'RNWGX', name: 'American Funds New World R6' },
  { ticker: 'OIBIX', name: 'Invesco International Bond R6' },
  { ticker: 'RTRIX', name: 'Royce Small-Cap Total Return' },
  { ticker: 'DRRYX', name: 'BNY Mellon Global Real Return' },
  { ticker: 'VWIGX', name: 'Vanguard International Growth' },
  { ticker: 'TGEPX', name: 'TCW Emerging Markets Income' },
  { ticker: 'BPLBX', name: 'BlackRock Inflation Protected Bond' },
  { ticker: 'CFSTX', name: 'Commerce Short Term Government' },
  { ticker: 'MWTSX', name: 'MetWest Total Return Bond' },
  { ticker: 'FXAIX', name: 'Fidelity 500 Index Fund' },
  { ticker: 'FDRXX', name: 'Fidelity Government Cash Reserves' },
  { ticker: 'ADAXX', name: 'Invesco Government Money Market' },
  { ticker: 'WEGRX', name: 'Allspring Emerging Growth R6' },
  { ticker: 'BGHIX', name: 'BrandywineGLOBAL High Yield I' },
  { ticker: 'HRAUX', name: 'Carillon Eagle Mid Cap Growth' },
  { ticker: 'FSPGX', name: 'Fidelity Large Cap Growth Index' },
];

export const GICS_SECTORS = {
  'Technology':             { etf: 'XLK',  color: '#1D4ED8' },
  'Financials':             { etf: 'XLF',  color: '#059669' },
  'Healthcare':             { etf: 'XLV',  color: '#DC2626' },
  'Consumer Discretionary': { etf: 'XLY',  color: '#D97706' },
  'Consumer Staples':       { etf: 'XLP',  color: '#7C3AED' },
  'Energy':                 { etf: 'XLE',  color: '#B45309' },
  'Industrials':            { etf: 'XLI',  color: '#0891B2' },
  'Materials':              { etf: 'XLB',  color: '#65A30D' },
  'Utilities':              { etf: 'XLU',  color: '#6B7280' },
  'Real Estate':            { etf: 'XLRE', color: '#EC4899' },
  'Communication Services': { etf: 'XLC',  color: '#8B5CF6' },
};

export const FRED_SERIES = {
  DFF:          'Fed Funds Rate',
  T10Y2Y:       '10Y-2Y Yield Curve',
  CPIAUCSL:     'CPI YoY',
  UNRATE:       'Unemployment Rate',
  BAMLH0A0HYM2: 'HY Credit Spread',
  DCOILWTICO:   'WTI Crude Oil (daily)',
  INDPRO:       'Industrial Production',
  UMCSENT:      'Consumer Sentiment',
  T10YIE:       'Breakeven Inflation 10Y',
  DTWEXBGS:     'USD Broad Index',
};

export const MONEY_MARKET_FUNDS = new Set(['FDRXX', 'ADAXX']);

export const COMPANY_CODES = {
  TA26: { name: 'TerrAscend', funds: DEFAULT_FUNDS },
};

// Per-fund notable facts displayed in Rankings tab and passed to manager.js.
// Structure: array of { text, sentiment } per ticker.
// Each fund can have multiple simultaneous alerts — positive, negative, or neutral.
// sentiment values: 'positive' | 'negative' | 'neutral'
// Claude receives all alerts and assesses each on its own merits.
export const ALERTS = {
  PRPFX: [{ text: 'Single-manager risk (Cuggino)',          sentiment: 'negative' }],
  QFVRX: [{ text: 'Fee waiver expires 7/31/2026',           sentiment: 'negative' }],
  RNWGX: [{ text: 'Benchmark changed 1/1/2026',             sentiment: 'neutral'  }],
  VWIGX: [{ text: 'Beta 1.34; Baillie Gifford modifying',   sentiment: 'neutral'  }],
  WFPRX: [{ text: '2025 underperformed benchmark 4.82pp',   sentiment: 'negative' }],
  OIBIX: [{ text: 'New manager Block added 2025',            sentiment: 'neutral'  }],
  MADFX: [{ text: 'AUM ~$55M viability concern',             sentiment: 'negative' }],
  TGEPX: [{ text: 'Expense cap expired Feb 2026',            sentiment: 'negative' }],
  VADFX: [{ text: 'Process downgraded Jul 2024',             sentiment: 'negative' }],
  BPLBX: [{ text: 'New lead PM; 227% turnover',              sentiment: 'negative' }],
  RTRIX: [{ text: 'Founder Royce transitioning out',         sentiment: 'negative' }],
  DRRYX: [{ text: 'PM overhaul - Morningstar Under Review',  sentiment: 'negative' }],
  MWTSX: [{ text: 'Leadership transition Nov 2025',          sentiment: 'neutral'  }],
  CFSTX: [{ text: 'AUM $29.4M viability risk',               sentiment: 'negative' }],
  ADAXX: [{ text: 'Closed to new investors May 2020',        sentiment: 'neutral'  }],
  BGHIX: [{ text: 'Lead PM departed Jul 2025',               sentiment: 'negative' }],
  WEGRX: [{ text: 'Fee waiver expires 8/31/2026',            sentiment: 'negative' }],
  HRAUX: [{ text: '12% cap gain distribution early 2026',    sentiment: 'negative' }],
};

export const SEED = {
  PRPFX: { composite: 7.8 }, WFPRX: { composite: 6.1 },
  VFWAX: { composite: 7.2 }, QFVRX: { composite: 6.4 },
  MADFX: { composite: 5.5 }, VADFX: { composite: 4.8 },
  RNWGX: { composite: 6.8 }, OIBIX: { composite: 5.2 },
  RTRIX: { composite: 4.1 }, DRRYX: { composite: 3.8 },
  VWIGX: { composite: 6.5 }, TGEPX: { composite: 5.8 },
  BPLBX: { composite: 5.0 }, CFSTX: { composite: 4.5 },
  MWTSX: { composite: 4.2 }, FXAIX: { composite: 4.5 },
  FDRXX: { composite: 3.5 }, ADAXX: { composite: 3.4 },
  WEGRX: { composite: 3.2 }, BGHIX: { composite: 3.5 },
  HRAUX: { composite: 3.0 }, FSPGX: { composite: 3.8 },
};

export const DEFAULT_WEIGHTS = { mandateScore: 40, momentum: 25, riskAdj: 20, managerQuality: 15 };

export const FACTOR_LABELS = {
  mandateScore:   { label: 'Macro Fit',    desc: "How well this fund's investment mandate aligns with current macro conditions" },
  momentum:       { label: 'Market Feel',  desc: 'Recent price trend (63-day momentum) Ã¢ÂÂ the market\'s current vote on this fund' },
  riskAdj:        { label: 'Room to Run',  desc: 'Return quality relative to risk (Sharpe ratio)' },
  managerQuality: { label: 'Foundations',  desc: 'Management team quality, fund stability, parent company reputation, and fee structure' },
};

export const WIZARD_STEPS = {
  titles: ['', 'Your Investor Profile', 'Your Fund Universe', 'What Matters to You', 'Ready to Go!'],
  subs: ['',
    'Tell us your name and Ã¢ÂÂ if your employer has a FundLens code Ã¢ÂÂ enter it to instantly load your 401K fund options.',
    'Review the funds available in your 401K. You can add or remove tickers at any time.',
    'These four factors drive how FundLens ranks your funds. Adjust them to reflect what you personally believe matters most.',
    'FundLens will analyze the world right now and surface the funds built for this moment.',
  ],
};

export const WIZARD_FACTORS = [
  { key: 'mandateScore', label: 'Macro Fit', emoji: 'Ã°ÂÂÂ',
    what: "How well does this fund's strategy match what's happening in the economy right now?",
    conservative: "Matters somewhat Ã¢ÂÂ you want funds that aren't fighting the macro tide.",
    aggressive: "Matters a lot Ã¢ÂÂ you're betting on the macro call being right." },
  { key: 'momentum', label: 'Market Feel', emoji: 'Ã°ÂÂÂ',
    what: 'Is this fund already moving in the right direction? Recent 63-day price trend.',
    conservative: "Matters less Ã¢ÂÂ past movement doesn't guarantee safety.",
    aggressive: 'Matters a lot Ã¢ÂÂ you want funds the market is already rewarding.' },
  { key: 'riskAdj', label: 'Room to Run', emoji: 'Ã¢ÂÂÃ¯Â¸Â',
    what: 'Does this fund deliver returns without wild swings? (Sharpe ratio Ã¢ÂÂ return per unit of risk)',
    conservative: 'Matters most Ã¢ÂÂ you want steady returns, not a rollercoaster.',
    aggressive: "Matters less Ã¢ÂÂ you're willing to accept volatility for bigger gains." },
  { key: 'managerQuality', label: 'Foundations', emoji: 'Ã°ÂÂÂÃ¯Â¸Â',
    what: "How consistently has this fund's management team executed over time?",
    conservative: "Matters more Ã¢ÂÂ you want a fund you can trust to do what it says.",
    aggressive: "Matters as a floor Ã¢ÂÂ you still don't want a badly run fund." },
];

export const DEFAULT_WORLD_TTL_MINS = 60;

export const RSS_FEEDS = [
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', label: 'CNBC Markets' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', label: 'CNBC Economy' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',                          label: 'MarketWatch' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',                         label: 'MarketWatch Pulse' },
];

export function getTierFromModZ(modZ) {
  if (modZ >= 2.0)  return 'BREAKAWAY';
  if (modZ >= 1.2)  return 'STRONG';
  if (modZ >= 0.3)  return 'SOLID';
  if (modZ >= -0.5) return 'NEUTRAL';
  return 'WEAK';
}


// â News collection constants ââââââââââââââââââââââââââââââââââââââââââââââ
// MAX_HEADLINES: total headlines stored per world run (RSS + GDELT combined,
// after deduplication). Increase here as new sources are added â no logic changes.
export const MAX_HEADLINES = 50;

// GDELT_QUERY: the search terms passed to GDELT's artlist endpoint.
// Kept broad intentionally â world context should give Claude a wide-angle
// macro view, not a pre-filtered one. Tune here without touching world.js.
export const GDELT_QUERY = 'finance economy market Federal Reserve inflation';

// Single source of truth for the Claude model used across all engine files.
// Update here when the model changes Ã¢ÂÂ do not hardcode in individual files.
export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
