// FundLens v4 — Supabase cache helpers
// All Supabase calls route through the Railway /api/supabase proxy so the
// service_role key (which bypasses RLS) never touches the client.
// The proxy injects the Authorization header server-side.

// — Low-level REST helpers ————————————————————————————————————————————————

async function supaFetch(path, options = {}) {
  // Route through proxy — service_role key is injected by server.js.
  // Direct Supabase calls with the anon key fail RLS on every shared table.
  const url = `/api/supabase${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Prefer':       options.prefer ?? '',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// — holdings_cache ————————————————————————————————————————————————————————
// Strategy: DELETE all rows for ticker, then INSERT fresh batch.
// This is the required pattern — no upsert.
// TTL: 15 days — N-PORT-P filings are submitted monthly (within 60 days of
// month-end), so holdings can change monthly. 15 days keeps data fresh
// without hammering EDGAR on every run.

export async function getHoldings(ticker) {
  const rows = await supaFetch(
    `/holdings_cache?fund_ticker=eq.${encodeURIComponent(ticker)}&order=weight.desc`
  );
  if (!rows?.length) return null;
  const age = Date.now() - new Date(rows[0].cached_at).getTime();
  if (age > 15 * 24 * 60 * 60 * 1000) return null;  // expired
  return rows;
}

export async function setHoldings(ticker, rows) {
  // 1. Delete existing rows for this fund
  await supaFetch(`/holdings_cache?fund_ticker=eq.${encodeURIComponent(ticker)}`, {
    method: 'DELETE',
  });

  if (!rows?.length) return;

  // 2. Insert fresh rows
  const now     = new Date().toISOString();
  const payload = rows.map(r => ({ ...r, fund_ticker: ticker, cached_at: now }));
  return supaFetch('/holdings_cache', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body:   JSON.stringify(payload),
  });
}

// — sector_mappings ————————————————————————————————————————————————————————

export async function getSectorMapping(ticker) {
  const rows = await supaFetch(
    `/sector_mappings?ticker=eq.${encodeURIComponent(ticker)}&limit=1`
  );
  return rows?.[0] ?? null;
}

export async function setSectorMapping(ticker, sector, industry) {
  return supaFetch('/sector_mappings', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body:   JSON.stringify({ ticker, sector, industry, cached_at: new Date().toISOString() }),
  });
}

// — manager_scores ————————————————————————————————————————————————————————
// 30-day cache

export async function getManagerScore(ticker) {
  const rows = await supaFetch(
    `/manager_scores?ticker=eq.${encodeURIComponent(ticker)}&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;
  const age = Date.now() - new Date(row.cached_at).getTime();
  if (age > 30 * 24 * 60 * 60 * 1000) return null;  // expired
  return row;
}

export async function setManagerScore(ticker, score, reasoning) {
  return supaFetch('/manager_scores', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body:   JSON.stringify({ ticker, score, reasoning, cached_at: new Date().toISOString() }),
  });
}

// — fund_profiles (expense ratios) ————————————————————————————————————————
// 90-day cache

export async function getFundProfile(ticker) {
  const rows = await supaFetch(
    `/fund_profiles?ticker=eq.${encodeURIComponent(ticker)}&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > 90 * 24 * 60 * 60 * 1000) return null;  // expired
  return row;
}

export async function setFundProfile(ticker, data) {
  return supaFetch('/fund_profiles', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body:   JSON.stringify({ ticker, ...data, fetched_at: new Date().toISOString() }),
  });
}

// — cached_world_data ————————————————————————————————————————————————————
// Single row (id=1), no TTL check here — pipeline decides when to refresh.

export async function getWorldData() {
  const rows = await supaFetch('/cached_world_data?id=eq.1&limit=1');
  return rows?.[0] ?? null;
}

export async function setWorldData(fredData, headlines) {
  return supaFetch('/cached_world_data', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body:   JSON.stringify({
      id:         1,
      fred_data:  fredData,
      headlines,
      fetched_at: new Date().toISOString(),
    }),
  });
}

// — run_history ——————————————————————————————————————————————————————————

export async function saveRunHistory(userId, { dominantTheme, macroStance, fundScores, sectorScores }) {
  return supaFetch('/run_history', {
    method: 'POST',
    prefer: 'return=minimal',
    body:   JSON.stringify({
      user_id:       userId,
      ran_at:        new Date().toISOString(),
      dominant_theme: dominantTheme,
      macro_stance:  macroStance,
      fund_scores:   fundScores,
      sector_scores: sectorScores,
    }),
  });
}

export async function getLastRun(userId) {
  const rows = await supaFetch(
    `/run_history?user_id=eq.${encodeURIComponent(userId)}&order=ran_at.desc&limit=1`
  );
  return rows?.[0] ?? null;
}

// — user_weights ——————————————————————————————————————————————————————————

export async function getUserWeights(userId) {
  const rows = await supaFetch(
    `/user_weights?user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  return rows?.[0] ?? null;
}
