// src/services/api.js
// Generic API helpers used by all engine and UI files.
// All Supabase data queries route through /api/supabase (Railway proxy).
// All Claude calls route through /api/claude (Railway proxy injects the key).
// All external data fetches (FRED, Treasury, GDELT, RSS) route through
// their respective Railway proxy endpoints — never hit external APIs directly.
// No direct Supabase data calls. No localStorage.

// ---------------------------------------------------------------------------
// apiFetch
// ---------------------------------------------------------------------------
// Base wrapper around fetch(). Returns parsed JSON.
// Throws on non-2xx responses with the status code and path included.

export async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);

  if (!res.ok) {
    throw new Error(`apiFetch ${res.status} — ${path}`);
  }

  // 204 No Content and similar — return null rather than trying to parse.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// callClaude
// ---------------------------------------------------------------------------
// POST to /api/claude.
// Caller is responsible for providing model, max_tokens, messages, etc.
// Does NOT inject defaults — keeps each call site explicit and auditable.

export async function callClaude(body) {
  return apiFetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// supaFetch
// ---------------------------------------------------------------------------
// Fetches from /api/supabase/{pathAndQuery}.
// Sets PostgREST-compatible headers based on HTTP method.

export async function supaFetch(pathAndQuery, options = {}) {
  const method  = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };

  switch (method) {
    case 'GET':
      headers['Prefer'] = 'return=representation';
      break;

    case 'POST':
      headers['Content-Type'] = 'application/json';
      headers['Prefer']       = 'resolution=merge-duplicates,return=representation';
      break;

    case 'PATCH':
      headers['Content-Type'] = 'application/json';
      headers['Prefer']       = 'return=representation';
      break;

    case 'DELETE':
      headers['Prefer'] = 'return=minimal';
      break;

    default:
      break;
  }

  const url = `/api/supabase/${pathAndQuery}`;
  const res = await fetch(url, { ...options, method, headers });

  if (!res.ok) {
    throw new Error(`supaFetch ${res.status} — ${url}`);
  }

  // DELETE with return=minimal returns 204 — resolve to null.
  if (method === 'DELETE' || res.status === 204) {
    return null;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// supaUpsert
// ---------------------------------------------------------------------------
// Convenience wrapper: POST a row (or array of rows) to a Supabase table.
// Uses merge-duplicates so it acts as an upsert.

export async function supaUpsert(table, data) {
  return supaFetch(table, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ---------------------------------------------------------------------------
// supaDelete
// ---------------------------------------------------------------------------
// Convenience wrapper: DELETE rows from a Supabase table.
// query is the raw PostgREST query string, e.g. "user_id=eq.abc123"

export async function supaDelete(table, query) {
  return supaFetch(`${table}?${query}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// fetchFredSeries
// ---------------------------------------------------------------------------
// Fetch a single FRED economic series via the Railway proxy.
// seriesId: e.g. "UNRATE", "CPIAUCSL", "FEDFUNDS"
// Returns: { observations: [{ date, value }, ...] }
// Observations arrive sorted descending (most recent first).
// world.js calls this sequentially — FRED rate-limits concurrent requests.

export async function fetchFredSeries(seriesId) {
  return apiFetch(`/api/fred/${encodeURIComponent(seriesId)}`);
}

// ---------------------------------------------------------------------------
// fetchTreasury
// ---------------------------------------------------------------------------
// Fetch the current Treasury yield curve via the Railway proxy.
// Returns: { date, y1, y2, y5, y10, y30 }
// world.js uses the values to compute four yield spreads (shortEnd, belly,
// classic, longEnd) which feed into the thesis generation pipeline.

export async function fetchTreasury() {
  return apiFetch('/api/treasury');
}

// ---------------------------------------------------------------------------
// fetchGdelt
// ---------------------------------------------------------------------------
// Fetch financial news articles from GDELT via the Railway proxy.
// params: { query, mode, maxrecords, format }
//   query:      GDELT_QUERY string from constants.js
//   mode:       'artlist' (article list)
//   maxrecords: number of articles to request
//   format:     'json'
// Returns: { articles: [{ title, url, seendate, ... }, ...] }

export async function fetchGdelt(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const path = qs ? `/api/gdelt?${qs}` : '/api/gdelt';
  return apiFetch(path);
}

// ---------------------------------------------------------------------------
// fetchRSS
// ---------------------------------------------------------------------------
// Fetch a raw RSS/Atom feed via the Railway proxy and return the XML text.
// The proxy avoids CORS restrictions on external RSS endpoints.
// Returns: raw XML string — NOT JSON. world.js parses it with DOMParser.
// apiFetch cannot be used here because RSS responses are text/xml, not JSON.

export async function fetchRSS(feedUrl) {
  const path = `/api/rss?url=${encodeURIComponent(feedUrl)}`;
  const res  = await fetch(path);

  if (!res.ok) {
    throw new Error(`fetchRSS ${res.status} — ${path}`);
  }

  return res.text();
}
