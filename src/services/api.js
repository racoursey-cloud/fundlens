// src/services/api.js
// Generic API helpers used by all engine and UI files.
// All Supabase data queries route through /api/supabase (Railway proxy).
// All Claude calls route through /api/claude (Railway proxy injects the key).
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
