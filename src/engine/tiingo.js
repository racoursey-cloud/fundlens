import { GICS_SECTORS } from './constants.js';

// Module-level in-memory cache — lives for the duration of the page session.
let tiingoCache  = {};   // { [ticker]: { data, cachedAt } }
let _marketOpen  = false;
let _tiingoStale = false; // true when X-Tiingo-Cache: STALE received

// ── Market helpers ────────────────────────────────────────────────────────────

export function checkMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const h   = et.getHours() + et.getMinutes() / 60;
  _marketOpen = (day >= 1 && day <= 5 && h >= 9.5 && h < 16);
  return _marketOpen;
}

export function isMarketOpen()  { return _marketOpen;  }
export function isTiingoStale() { return _tiingoStale; }

// ── Core fetch ────────────────────────────────────────────────────────────────

export async function fetchTiingo(ticker) {
  // Serve from in-memory cache when market is closed and we already have data.
  if (!_marketOpen && tiingoCache[ticker]) {
    return tiingoCache[ticker].data;
  }

  // ~95 calendar days ensures >=63 trading days of price history.
  const end   = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 95);
  const fmt = d => d.toISOString().slice(0, 10);

  const url = '/api/tiingo/tiingo/daily/' + ticker + '/prices'
    + '?startDate=' + fmt(start) + '&endDate=' + fmt(end);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    if (tiingoCache[ticker]) return tiingoCache[ticker].data;
    throw err;
  }

  if (res.status === 429) {
    if (tiingoCache[ticker]) return tiingoCache[ticker].data;
    throw new Error('Tiingo 429 for ' + ticker + ' and no cache available');
  }

  if (res.headers?.get('X-Tiingo-Cache') === 'STALE') {
    _tiingoStale = true;
  }

  if (!res.ok) {
    if (tiingoCache[ticker]) return tiingoCache[ticker].data;
    throw new Error('Tiingo ' + res.status + ' for ' + ticker);
  }

  const raw    = await res.json();
  const prices = raw.map(d => d.adjClose || d.close).filter(Boolean);

  if (prices.length < 20) {
    throw new Error('Tiingo: insufficient data for ' + ticker + ' (' + prices.length + ' points)');
  }

  const latest = prices[prices.length - 1];
  const p63    = prices[Math.max(0, prices.length - 64)];
  const p21    = prices[Math.max(0, prices.length - 22)];

  const mom63    = ((latest - p63) / p63) * 100;
  const mom21    = ((latest - p21) / p21) * 100;
  const momentum = Math.min(10, Math.max(0, 5 + mom63 * 0.35 + mom21 * 0.15));

  // Annualised Sharpe, risk-free rate 4.3%
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    rets.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const mean     = rets.reduce((s, r) => s + r, 0) / rets.length * 252;
  const variance = rets.reduce((s, r) => s + Math.pow(r - mean / 252, 2), 0) / rets.length;
  const std      = Math.sqrt(variance) * Math.sqrt(252);
  const sharpe   = std > 0 ? (mean - 0.043) / std : 0;
  const riskAdj  = Math.min(10, Math.max(0, 5 + sharpe * 1.8));

  const result = {
    momentum: +momentum.toFixed(2),
    riskAdj:  +riskAdj.toFixed(2),
    nav:      latest,
    mom63:    +mom63.toFixed(2),
    mom21:    +mom21.toFixed(2),
  };

  tiingoCache[ticker] = { data: result, cachedAt: Date.now() };
  return result;
}

// ── Sector momentum — all 11 GICS ETFs concurrently ──────────────────────────

export async function fetchSectorMomentum() {
  const FALLBACK = { momentum: 5, mom63: 0, mom21: 0, riskAdj: 5 };

  const results = await Promise.all(
    Object.entries(GICS_SECTORS).map(async ([sector, { etf }]) => {
      try {
        const data = await fetchTiingo(etf);
        return [sector, data];
      } catch (_) {
        return [sector, { ...FALLBACK }];
      }
    })
  );

  return Object.fromEntries(results);
}
