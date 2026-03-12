// FundLens v4 — Railway proxy server
// Serves the Vite build and proxies all external API calls.
// API keys are NEVER sent to the client — injected here server-side.
// Port: Railway sets $PORT automatically; we default to 3000 locally.

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Environment variables (injected by Railway) ───────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const TINNGO_KEY     = process.env.TINNGO_KEY;    // intentional typo — matches Railway var name
const FRED_KEY       = process.env.FRED_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY;
const SUPA_URL       = process.env.SUPA_URL;
const SUPA_KEY       = process.env.SUPA_KEY;      // service_role — server only, never client
const SUPA_ANON_KEY  = process.env.SUPA_ANON_KEY;

// Parse JSON request bodies (up to 2MB for Claude responses)
app.use(express.json({ limit: '2mb' }));

// ── Generic proxy helper ──────────────────────────────────────────
// Forwards the request to `url` with injected headers, streams the response back.
async function proxyFetch(req, res, url, extraHeaders = {}) {
  try {
    const opts = {
      method: req.method,
      headers: { ...extraHeaders },
      signal: AbortSignal.timeout(35000),
    };

    // Forward body for mutating methods
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body && Object.keys(req.body).length) {
      opts.body = JSON.stringify(req.body);
    }

    // Forward Supabase-specific headers the client sends
    const fwd = ['prefer', 'content-type', 'range'];
    fwd.forEach(h => { if (req.headers[h]) opts.headers[h] = req.headers[h]; });

    const upstream = await fetch(url, opts);

    // Copy status + safe headers back to client
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const skip = ['transfer-encoding', 'connection', 'keep-alive'];
      if (!skip.includes(k.toLowerCase())) res.setHeader(k, v);
    });

    const body = await upstream.text();
    res.send(body);
  } catch (e) {
    console.error(`[proxy] ${req.method} ${url} →`, e.message);
    res.status(502).json({ error: 'Upstream request failed', detail: e.message });
  }
}

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '4.0.0' }));

// ── Claude ────────────────────────────────────────────────────────
// x-api-key is injected here — never sent from client
app.post('/api/claude', (req, res) =>
  proxyFetch(req, res, 'https://api.anthropic.com/v1/messages', {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  })
);

// ── Tiingo — NAV, momentum, Sharpe ────────────────────────────────
app.all('/api/tiingo/*', (req, res) => {
  const upstream = req.path.replace('/api/tiingo', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://api.tiingo.com${upstream}${qs}`, {
    Authorization: `Token ${TINNGO_KEY}`,
    'Content-Type': 'application/json',
  });
});

// ── FRED — 10 macro series, sequential fetch ───────────────────────
// FRED_KEY appended as query param (their API requires it that way)
app.all('/api/fred/*', (req, res) => {
  const upstream = req.path.replace('/api/fred', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const sep = qs ? '&' : '?';
  proxyFetch(req, res, `https://api.stlouisfed.org/fred${upstream}${qs}${sep}api_key=${FRED_KEY}&file_type=json`);
});

// ── Supabase PostgREST ─────────────────────────────────────────────
// Uses service_role key so writes bypass RLS (shared tables: holdings_cache, etc.)
// Client-initiated reads for user tables go through RLS via JWT in the request
// but we use service_role here to allow the proxy to read/write shared cache tables.
app.all('/api/supabase/*', (req, res) => {
  const upstream = req.path.replace('/api/supabase', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `${SUPA_URL}/rest/v1${upstream}${qs}`, {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
  });
});

// ── GDELT — geopolitical headlines (public, no key) ────────────────
app.all('/api/gdelt', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://api.gdeltproject.org/api/v2/doc/doc${qs}`);
});

// ── SEC EDGAR submissions API ──────────────────────────────────────
app.all('/api/edgar/*', (req, res) => {
  const upstream = req.path.replace('/api/edgar', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://data.sec.gov/submissions${upstream}${qs}`, {
    'User-Agent': 'FundLens/4.0 admin@fundlens.app',
    Accept: 'application/json',
  });
});

// ── SEC EFTS full-text search ──────────────────────────────────────
app.all('/api/efts/*', (req, res) => {
  const upstream = req.path.replace('/api/efts', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://efts.sec.gov/LATEST${upstream}${qs}`, {
    'User-Agent': 'FundLens/4.0 admin@fundlens.app',
  });
});

// ── SEC www4 — filing archives + MF tickers file ──────────────────
app.all('/api/www4sec/*', (req, res) => {
  const upstream = req.path.replace('/api/www4sec', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://www.sec.gov${upstream}${qs}`, {
    'User-Agent': 'FundLens/4.0 admin@fundlens.app',
    Accept: '*/*',
  });
});

// ── Twelvedata — live gold price (XAU/USD) ─────────────────────────
app.all('/api/twelvedata/*', (req, res) => {
  const upstream = req.path.replace('/api/twelvedata', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const sep = qs ? '&' : '?';
  proxyFetch(req, res, `https://api.twelvedata.com${upstream}${qs}${sep}apikey=${TWELVEDATA_KEY}`);
});

// ── Treasury yield curve — XML → JSON ─────────────────────────────
app.get('/api/treasury', async (req, res) => {
  try {
    // Use current year-month; Treasury XML updates daily
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${ym}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(r.status).json({ error: 'Treasury fetch failed' });
    const xml = await r.text();

    // Extract the last <entry> block (most recent trading day)
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
    if (!entries.length) return res.json({});
    const latest = entries[entries.length - 1];

    const getVal = tag => {
      const m = latest.match(new RegExp(`<d:${tag}[^>]*>([^<]+)<`));
      return m ? parseFloat(m[1]) : null;
    };
    res.json({
      date:  latest.match(/<d:NEW_DATE[^>]*>([^<T]+)/)?.[1]?.trim() || null,
      y1:  getVal('BC_1YEAR'),
      y2:  getVal('BC_2YEAR'),
      y5:  getVal('BC_5YEAR'),
      y10: getVal('BC_10YEAR'),
      y30: getVal('BC_30YEAR'),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── RSS proxy — CORS bypass for financial news feeds ──────────────
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'FundLens/4.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(r.status).send('');
    const text = await r.text();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Serve Vite production build (SPA catch-all) ───────────────────
const distPath = join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`FundLens v4 running on port ${PORT}`);
});
