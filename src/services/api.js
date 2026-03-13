// FundLens v4 — Proxy API wrappers
// All external API calls route through the Railway proxy (server.js).
// No API keys are ever present in the client.

const BASE = '';  // Same origin — Railway serves both static files and the proxy

// — Core fetch wrapper ————————————————————————————————————————————————————

async function apiFetch(path, options = {}, retries = 1) {
  const timeout = options.timeout ?? 30000;
  const opts = {
    method:  options.method  ?? 'GET',
    headers: options.headers ?? {},
    signal:  AbortSignal.timeout(timeout),
  };
  if (options.body) {
    opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    opts.headers['Content-Type'] = opts.headers['Content-Type'] ?? 'application/json';
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, opts);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function apiJSON(path, options = {}, retries = 1) {
  const res = await apiFetch(path, options, retries);
  return res.json();
}

async function apiText(path, options = {}, retries = 1) {
  const res = await apiFetch(path, options, retries);
  return res.text();
}

// — Claude ————————————————————————————————————————————————————————————————

export async function callClaude({ system, user, maxTokens = 1024, json = false }) {
  const messages = [{ role: 'user', content: user }];
  const body = { messages, max_tokens: maxTokens };
  if (system) body.system = system;

  const res = await apiFetch('/api/claude', {
    method: 'POST',
    body,
  });
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();

  if (!json) return text;

  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Claude returned invalid JSON: ${clean.slice(0, 300)}`);
  }
}

// — Tiingo ————————————————————————————————————————————————————————————————

export async function fetchTiingo(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `/api/tiingo${path}${qs ? '?' + qs : ''}`;
  return apiJSON(url, {}, 2);
}

// — FRED (sequential — NOT parallel, per architecture rules) ——————————————

export async function fetchFredSeries(seriesId) {
  // limit=5 gives 4 fallback observations for series with recent missing (.) values.
  // Monthly series (CPIAUCSL, UNRATE, INDPRO, UMCSENT) often have 1–3 consecutive
  // missing observations during the reporting lag period. limit=2 was insufficient.
  const url = `/api/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=5`;
  return apiJSON(url, {}, 2);
}

// — GDELT ————————————————————————————————————————————————————————————————

export async function fetchGdelt(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiJSON(`/api/gdelt${qs ? '?' + qs : ''}`, {}, 1);
}

// — SEC EDGAR ————————————————————————————————————————————————————————————

export async function fetchEdgar(path) {
  return apiJSON(`/api/edgar${path}`, {}, 2);
}

export async function fetchEfts(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiJSON(`/api/efts${path}${qs ? '?' + qs : ''}`, {}, 2);
}

export async function fetchSEC(path) {
  return apiText(`/api/www4sec${path}`, {}, 2);
}

// — Treasury ————————————————————————————————————————————————————————————

export async function fetchTreasury() {
  return apiJSON('/api/treasury', {}, 2);
}

// — RSS ——————————————————————————————————————————————————————————————————

export async function fetchRSS(feedUrl) {
  const qs = new URLSearchParams({ url: feedUrl }).toString();
  return apiText(`/api/rss?${qs}`, {}, 1);
}

// — Twelve Data ——————————————————————————————————————————————————————————

export async function fetchTwelveData(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiJSON(`/api/twelvedata${path}${qs ? '?' + qs : ''}`, {}, 2);
}
