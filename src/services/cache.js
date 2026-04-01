// src/services/cache.js
// All Supabase cache read/write helpers for FundLens v5.
// Every function routes through supaFetch() from api.js.
// No direct Supabase calls. No localStorage.
//
// TTL summary:
//   holdings_cache    → 15 days  (checked on first row cached_at)
//   manager_scores    → 30 days  (per-row cached_at filter)
//   fund_profiles     → 90 days  (per-row fetched_at filter)
//   tiingo_cache      → 1 day    (per-row cached_at filter)
//   sector_mappings   → permanent (no TTL)
//   source_registry   → no TTL   (admin-managed)
//   world / run /     → no TTL   (caller decides when to refresh)
//   user tables

import { supaFetch } from './api.js';

// ---------------------------------------------------------------------------
// Internal TTL helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function daysAgo(days) {
  return new Date(Date.now() - days * MS_PER_DAY);
}

function isStale(isoString, days) {
  if (!isoString) return true;
  return new Date(isoString) < daysAgo(days);
}

// Build an IN() filter list: ticker=in.(\"FXAIX\",\"VFIAX\")
function inList(tickers) {
  return tickers.map(t => `"${t}"`).join(',');
}

// ---------------------------------------------------------------------------
// Source Registry
// ---------------------------------------------------------------------------

/**
 * Returns the full source_registry array sorted by display_order.
 */
export async function getSourceRegistry() {
  const rows = await supaFetch('source_registry?order=display_order.asc');
  return rows ?? [];
}

/**
 * Returns the user's source preference overrides: [{ source_id, enabled }, ...]
 */
export async function getUserSourcePrefs(userId) {
  const rows = await supaFetch(
    `user_source_prefs?user_id=eq.${encodeURIComponent(userId)}`
  );
  return rows ?? [];
}

/**
 * Merges registry defaults with per-user overrides.
 * Returns the full source list, each item with an .enabled boolean.
 */
export async function getEnabledSources(userId) {
  const [registry, prefs] = await Promise.all([
    getSourceRegistry(),
    getUserSourcePrefs(userId),
  ]);

  const prefMap = new Map(prefs.map(p => [p.source_id, p.enabled]));

  return registry.map(source => ({
    ...source,
    enabled: prefMap.has(source.id)
      ? prefMap.get(source.id)
      : source.default_enabled,
  }));
}

/**
 * Upserts a single user source preference.
 */
export async function saveUserSourcePref(userId, sourceId, enabled) {
  return supaFetch('user_source_prefs', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, source_id: sourceId, enabled }),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// World Data
// ---------------------------------------------------------------------------

/**
 * Returns the cached world data object (id=1), or null if not found.
 */
export async function getWorldData() {
  const rows = await supaFetch('cached_world_data?id=eq.1');
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Upserts world data into cached_world_data row id=1.
 */
export async function saveWorldData(fredData, headlines, treasuryData) {
  return supaFetch('cached_world_data', {
    method: 'POST',
    body: JSON.stringify({
      id: 1,
      fred_data: fredData,
      headlines,
      treasury_data: treasuryData,
      cached_at: new Date().toISOString(),
    }),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// Holdings (15-day TTL, multi-row per fund)
// ---------------------------------------------------------------------------

/**
 * Returns holdings rows for a fund ticker, sorted by weight desc.
 * Returns null if no rows exist or if the first row is older than 15 days.
 */
export async function getHoldings(fundTicker) {
  const rows = await supaFetch(
    `holdings_cache?fund_ticker=eq.${encodeURIComponent(fundTicker)}&order=weight.desc`
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (isStale(rows[0].cached_at, 15)) return null;
  return rows;
}

/**
 * Replaces all holdings rows for a fund and inserts the fresh batch.
 * Rows are inserted in groups of 50 to avoid PostgREST payload limits.
 */
export async function saveHoldings(fundTicker, holdingsArray) {
  // Remove existing rows for this ticker first.
  await supaFetch(
    `holdings_cache?fund_ticker=eq.${encodeURIComponent(fundTicker)}`,
    { method: 'DELETE' }
  );

  if (!holdingsArray || holdingsArray.length === 0) return;

  const now = new Date().toISOString();
  const rows = holdingsArray.map(h => ({
    fund_ticker:    fundTicker,
    holding_name:   h.holding_name   ?? h.name   ?? null,
    holding_ticker: h.holding_ticker ?? h.ticker  ?? null,
    weight:         h.weight         ?? null,
    market_value:   h.market_value   ?? h.marketValue ?? null,
    shares:         h.shares         ?? null,
    asset_type:     h.asset_type     ?? h.assetType   ?? null,
    sector:         h.sector         ?? null,
    cached_at:      now,
  }));

  // Batch insert in groups of 50.
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    await supaFetch('holdings_cache', {
      method: 'POST',
      body: JSON.stringify(batch),
      headers: {
        'Prefer': 'return=representation',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Sector Mappings (permanent — no TTL)
// ---------------------------------------------------------------------------

/**
 * Returns all sector mappings as an array of { ticker, sector }.
 * Caller should build a Map from this.
 */
export async function getSectorMappings() {
  const rows = await supaFetch('sector_mappings?select=ticker,sector');
  return rows ?? [];
}

/**
 * Upserts a single sector mapping.
 */
export async function saveSectorMapping(ticker, sector, industry) {
  return supaFetch('sector_mappings?on_conflict=ticker', {
    method: 'POST',
    body: JSON.stringify({
      ticker,
      sector,
      industry: industry ?? null,
      cached_at: new Date().toISOString(),
    }),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

/**
 * Upserts an array of { ticker, sector, industry, cached_at } mappings.
 */
export async function saveSectorMappingsBatch(mappingsArray) {
  if (!mappingsArray || mappingsArray.length === 0) return;

  const now = new Date().toISOString();
  const rows = mappingsArray.map(m => ({
    ticker:    m.ticker,
    sector:    m.sector    ?? null,
    industry:  m.industry  ?? null,
    cached_at: m.cached_at ?? now,
  }));

  return supaFetch('sector_mappings?on_conflict=ticker', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// Manager Scores (30-day TTL)
// ---------------------------------------------------------------------------

/**
 * Returns a map of { TICKER: { score, reasoning, cached_at } } for the
 * given tickers. Rows older than 30 days are excluded.
 */
export async function getManagerScores(tickers) {
  if (!tickers || tickers.length === 0) return {};

  const rows = await supaFetch(
    `manager_scores?ticker=in.(${inList(tickers)})`
  );
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const result = {};
  for (const row of rows) {
    if (isStale(row.cached_at, 30)) continue;
    result[row.ticker.toUpperCase()] = {
      score:      row.score,
      reasoning:  row.reasoning,
      cached_at:  row.cached_at,
    };
  }
  return result;
}

/**
 * Upserts an array of { ticker, score, reasoning, cached_at }.
 */
export async function saveManagerScores(scoresArray) {
  if (!scoresArray || scoresArray.length === 0) return;

  return supaFetch('manager_scores?on_conflict=ticker', {
    method: 'POST',
    body: JSON.stringify(scoresArray),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// Fund Profiles / Expense Ratios (90-day TTL)
// ---------------------------------------------------------------------------

/**
 * Returns a map of { TICKER: { gross, net, note } } for the given tickers.
 * Rows older than 90 days are excluded (checked on fetched_at).
 */
export async function getExpenseRatios(tickers) {
  if (!tickers || tickers.length === 0) return {};

  const rows = await supaFetch(
    `fund_profiles?ticker=in.(${inList(tickers)})`
  );
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const result = {};
  for (const row of rows) {
    if (isStale(row.fetched_at, 90)) continue;
    result[row.ticker.toUpperCase()] = {
      gross: row.expense_gross ?? row.gross ?? null,
      net:   row.expense_net   ?? row.net   ?? null,
      note:  row.expense_note  ?? row.note  ?? null,
    };
  }
  return result;
}

/**
 * Upserts expense ratio rows.
 * ratiosObject: { TICKER: { gross, net, note }, ... }
 */
export async function saveExpenseRatios(ratiosObject) {
  if (!ratiosObject || Object.keys(ratiosObject).length === 0) return;

  const now = new Date().toISOString();
  const rows = Object.entries(ratiosObject).map(([ticker, data]) => ({
    ticker:        ticker.toUpperCase(),
    expense_gross: data.gross ?? null,
    expense_net:   data.net   ?? null,
    expense_note:  data.note  ?? null,
    fetched_at:    now,
  }));

  return supaFetch('fund_profiles?on_conflict=ticker', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// Tiingo Cache (1-day TTL)
// ---------------------------------------------------------------------------

/**
 * Returns a map of { TICKER: { nav, momentum, sharpe, riskAdj } } for the
 * given tickers. Rows older than 1 day are excluded.
 */
export async function getTiingoCache(tickers) {
  if (!tickers || tickers.length === 0) return {};

  const rows = await supaFetch(
    `tiingo_cache?ticker=in.(${inList(tickers)})`
  );
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const result = {};
  for (const row of rows) {
    if (isStale(row.cached_at, 1)) continue;
    result[row.ticker.toUpperCase()] = {
      nav:      row.nav      ?? null,
      momentum: row.momentum ?? null,
      sharpe:   row.sharpe   ?? null,
      riskAdj:  row.risk_adj ?? null,
    };
  }
  return result;
}

/**
 * Upserts a single ticker's Tiingo data.
 * data: { nav, momentum, sharpe, riskAdj, rawData? }
 */
export async function saveTiingoCache(ticker, data) {
  return supaFetch('tiingo_cache?on_conflict=ticker', {
    method: 'POST',
    body: JSON.stringify({
      ticker:    ticker.toUpperCase(),
      nav:       data.nav      ?? null,
      momentum:  data.momentum ?? null,
      sharpe:    data.sharpe   ?? null,
      risk_adj:  data.riskAdj  ?? null,
      raw_data:  data.rawData  ?? null,
      cached_at: new Date().toISOString(),
    }),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// Run History
// ---------------------------------------------------------------------------

/**
 * Returns up to `limit` run history rows for the user, newest first.
 */
export async function getRunHistory(userId, limit = 20) {
  const rows = await supaFetch(
    `run_history?user_id=eq.${encodeURIComponent(userId)}&order=ran_at.desc&limit=${limit}`
  );
  return rows ?? [];
}

/**
 * Returns the most recent run for the user, or null if none exists.
 */
export async function getLastRun(userId) {
  const rows = await getRunHistory(userId, 1);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Inserts a new run history row.
 * runData must include: user_id, dominant_theme, macro_stance,
 *   quarter_outlook, thesis_text, investor_letter, fund_scores,
 *   sector_scores, allocation, risk_tolerance, factor_weights, data_quality.
 */
export async function saveRunHistory(runData) {
  return supaFetch('run_history', {
    method: 'POST',
    body: JSON.stringify({
      ...runData,
      ran_at: runData.ran_at ?? new Date().toISOString(),
    }),
    headers: {
      'Prefer': 'return=representation',
    },
  });
}

// ---------------------------------------------------------------------------
// User Data
// ---------------------------------------------------------------------------

/**
 * Returns the user's fund list sorted by sort_order.
 */
export async function getUserFunds(userId) {
  const rows = await supaFetch(
    `user_funds?user_id=eq.${encodeURIComponent(userId)}&order=sort_order.asc`
  );
  return rows ?? [];
}

/**
 * Returns the user's saved factor weights, or null if not set.
 * Caller should apply defaults when null is returned.
 */
export async function getUserWeights(userId) {
  const rows = await supaFetch(
    `user_weights?user_id=eq.${encodeURIComponent(userId)}`
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Upserts factor weights for the user.
 * weights: { mandate, momentum, risk_adj, manager_quality, risk_tolerance, ... }
 */
export async function saveUserWeights(userId, weights) {
  return supaFetch('user_weights', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, ...weights }),
    headers: {
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
  });
}

/**
 * Returns the user's profile row from the profiles table, or null.
 */
export async function getUserProfile(userId) {
  const rows = await supaFetch(
    `profiles?id=eq.${encodeURIComponent(userId)}`
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}
