// FundLens v4 — Tiingo price metrics engine
// Fetches 63 trading days of adjusted close prices for a fund and computes:
//   - momentum:  63-day total return (price_today / price_63d_ago) - 1
//   - sharpe:    annualised Sharpe ratio over the 63-day window
//
// Architecture notes:
// - 63 trading days ≈ 3 calendar months. Standard intermediate momentum window.
// - Sharpe uses the daily Fed Funds Rate (DFF from FRED) as the risk-free rate.
//   Pass riskFreeRateAnnual from worldData.fredData.DFF.value; defaults to 0.
// - Cache TTL: 1 day (tiingo_cache table). Price metrics update daily.
// - MONEY_MARKET_FUNDS return a zero-score sentinel — no price fetch needed.
// - Never throws. Returns null metrics on any failure; scoring.js handles nulls.

import { MONEY_MARKET_FUNDS } from './constants.js';
import { getTiingoMetrics, setTiingoMetrics } from '../services/cache.js';
import { fetchTiingo } from '../services/api.js';

const MOMENTUM_DAYS   = 63;   // Trading days for momentum + Sharpe window
const TRADING_DAYS_PA = 252;  // Trading days per year for annualisation

// ── Math helpers ──────────────────────────────────────────────────────────────
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  const m   = mean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ── Compute metrics from price array ─────────────────────────────────────────
// prices: array of adjusted close prices, oldest first, length >= 2
// riskFreeRateAnnual: annualised risk-free rate as decimal (e.g. 0.0533 for 5.33%)
function computeMetrics(prices, riskFreeRateAnnual = 0) {
  if (!prices || prices.length < 2) return null;

  // Momentum: total return over the full window
  const momentum = (prices[prices.length - 1] / prices[0]) - 1;

  // Daily returns
  const dailyReturns = [];
  for (let i = 1; i < prices.length; i++) {
    dailyReturns.push((prices[i] / prices[i - 1]) - 1);
  }

  // Convert annual risk-free rate to daily equivalent
  const riskFreeDaily = riskFreeRateAnnual / TRADING_DAYS_PA;

  // Excess daily returns
  const excessReturns = dailyReturns.map(r => r - riskFreeDaily);

  const meanExcess = mean(excessReturns);
  const stdExcess  = stdDev(excessReturns);

  // Annualised Sharpe — guard against zero std dev (flat price series)
  const sharpe = stdExcess > 0
    ? (meanExcess / stdExcess) * Math.sqrt(TRADING_DAYS_PA)
    : 0;

  return {
    momentum: Math.round(momentum * 10000) / 10000,  // 4 decimal places
    sharpe:   Math.round(sharpe   * 1000)  / 1000,   // 3 decimal places
  };
}

// ── Tiingo price fetch ────────────────────────────────────────────────────────
// Fetches MOMENTUM_DAYS + 5 calendar days of daily adjusted prices to ensure
// we get at least MOMENTUM_DAYS trading day observations even around holidays.
async function fetchPrices(ticker) {
  // Request ~95 calendar days to guarantee 63+ trading day observations
  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 95);

  const fmt  = d => d.toISOString().split('T')[0];

  try {
    const data = await fetchTiingo(
      `/tiingo/daily/${encodeURIComponent(ticker)}/prices`,
      {
        startDate:   fmt(startDate),
        endDate:     fmt(endDate),
        resampleFreq: 'daily',
        sort:         'date',
      }
    );

    if (!Array.isArray(data) || data.length < 2) {
      console.warn(`[tiingo] Insufficient price data for ${ticker} (${data?.length ?? 0} rows)`);
      return null;
    }

    // Extract close prices, oldest first
    // Tiingo mutual fund endpoint returns { date, close } (NAV per share).
    // adjClose is only present on stock/ETF endpoints; fallback to close handles both.
    const prices = data
      .map(d => d.adjClose ?? d.close)
      .filter(p => p != null && p > 0);

    if (prices.length < 2) return null;

    // Trim to exactly MOMENTUM_DAYS + 1 points (need +1 for MOMENTUM_DAYS returns)
    return prices.slice(-( MOMENTUM_DAYS + 1));
  } catch (err) {
    console.warn(`[tiingo] Price fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
// Returns:
// {
//   momentum:  number | null,   ← 63-day total return, e.g. 0.0842 = +8.42%
//   sharpe:    number | null,   ← annualised Sharpe ratio
//   fromCache: boolean,
// }
//
// Money market funds return { momentum: 0, sharpe: 0, fromCache: false }.
// Returns { momentum: null, sharpe: null, fromCache: false } on any failure.
export async function fetchTiingoMetrics(ticker, riskFreeRateAnnual = 0) {
  // Money market funds: stable NAV, no meaningful momentum or Sharpe
  if (MONEY_MARKET_FUNDS.has(ticker)) {
    return { momentum: 0, sharpe: 0, fromCache: false };
  }

  // Check Supabase cache (1-day TTL enforced by getTiingoMetrics)
  try {
    const cached = await getTiingoMetrics(ticker);
    if (cached) {
      return {
        momentum:  cached.momentum  ?? null,
        sharpe:    cached.sharpe    ?? null,
        fromCache: true,
      };
    }
  } catch (err) {
    console.warn(`[tiingo] Cache read failed for ${ticker}:`, err.message);
  }

  // Fetch prices and compute
  const prices  = await fetchPrices(ticker);
  const metrics = computeMetrics(prices, riskFreeRateAnnual);

  if (!metrics) {
    return { momentum: null, sharpe: null, fromCache: false };
  }

  // Persist to Supabase
  try {
    await setTiingoMetrics(ticker, {
      momentum: metrics.momentum,
      sharpe:   metrics.sharpe,
    });
  } catch (err) {
    console.warn(`[tiingo] Cache write failed for ${ticker}:`, err.message);
    // Non-fatal
  }

  return { ...metrics, fromCache: false };
}
