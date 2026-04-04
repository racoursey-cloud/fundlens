/**
 * FundLens v5 \u2014 server/server.js
 * Railway backend: serves built frontend, proxies all upstream API calls.
 * API keys are injected server-side and never reach the browser.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// \u2500\u2500\u2500 Environment \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const {
  ANTHROPIC_KEY,
  TINNGO_KEY,       // intentional typo \u2014 do not change
  FRED_KEY,
  FINNHUB_KEY,
  TWELVEDATA_KEY,
  SUPA_URL,
  SUPA_KEY,
  SUPA_ANON_KEY,
  PORT = 3000,
} = process.env;

// \u2500\u2500\u2500 Middleware \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '../dist')));

// \u2500\u2500\u2500 In-memory caches \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Each entry: { value, expiresAt }
const tiingoCache  = {};  // key: `${ticker}|${qs}` \u2014 expires at ET midnight
const fredCache    = {};  // key: path+qs \u2014 24h TTL
const treasuryCache = {}; // single key 'yield' \u2014 24h TTL
const rssCache     = {};  // key: url \u2014 30min TTL
const twelveCache  = {};  // key: path+qs \u2014 24h TTL
const finnhubCache = {};  // key: path+qs \u2014 24h TTL (A14)

// GDELT rate-limit state
let gdeltLastCall = 0;
const GDELT_MIN_INTERVAL_MS = 5000;

// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * proxyFetch \u2014 wraps native fetch with a 25-second AbortController timeout.
 */
async function proxyFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * todayET \u2014 returns today's date in Eastern Time as "YYYY-MM-DD".
 */
function todayET() {
  return new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Milliseconds until midnight ET (for Tiingo cache TTL). */
function msUntilETMidnight() {
  const now = new Date();
  const etMidnight = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  etMidnight.setHours(24, 0, 0, 0);
  // Compute ET midnight in UTC
  const etOffsetMs = now.getTime() - new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  ).getTime();
  return etMidnight.getTime() - new Date().getTime() + etOffsetMs;
}

function isExpired(entry) {
  return !entry || Date.now() > entry.expiresAt;
}

function cacheSet(store, key, value, ttlMs) {
  store[key] = { value, expiresAt: Date.now() + ttlMs };
}

function cacheGet(store, key) {
  const entry = store[key];
  if (!entry) return null;
  if (isExpired(entry)) return null;
  return entry.value;
}

/** Returns stale value regardless of expiry (for fallback use). */
function cacheGetStale(store, key) {
  return store[key]?.value ?? null;
}

// \u2500\u2500\u2500 Route 1: Claude proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.post('/api/claude', async (req, res) => {
  try {
    const upstream = await proxyFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[claude]', err.message);
    res.status(502).json({ error: 'Claude proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 Route 2: Tiingo proxy with ET-day cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/tiingo/*', async (req, res) => {
  const suffix = req.params[0];                       // everything after /api/tiingo/
  const qs     = new URLSearchParams(req.query).toString();
  const cacheKey = `${suffix}|${qs}`;

  const cached = cacheGet(tiingoCache, cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://api.tiingo.com/${suffix}${qs ? '?' + qs : ''}`;
    const upstream = await proxyFetch(url, {
      headers: { Authorization: `Token ${TINNGO_KEY}` },
    });

    if (upstream.status === 429) {
      const stale = cacheGetStale(tiingoCache, cacheKey);
      if (stale) {
        console.warn('[tiingo] 429 \u2014 serving stale cache for', cacheKey);
        return res.json(stale);
      }
      return res.status(429).json({ error: 'Tiingo rate limited, no cache available' });
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();
    // Cache until ET midnight so price data stays fresh per trading day
    cacheSet(tiingoCache, cacheKey, data, msUntilETMidnight());
    res.json(data);
  } catch (err) {
    const stale = cacheGetStale(tiingoCache, cacheKey);
    if (stale) {
      console.warn('[tiingo] error \u2014 serving stale cache:', err.message);
      return res.json(stale);
    }
    console.error('[tiingo]', err.message);
    res.status(502).json({ error: 'Tiingo proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 Route 3: Supabase REST proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Handles GET, POST, PATCH, DELETE \u2014 forwards Prefer header for upsert/return
['get', 'post', 'patch', 'delete'].forEach((method) => {
  app[method]('/api/supabase/*', async (req, res) => {
    const suffix = req.params[0];
    const qs     = new URLSearchParams(req.query).toString();
    const url    = `${SUPA_URL}/rest/v1/${suffix}${qs ? '?' + qs : ''}`;

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
    };
    if (req.headers['prefer']) headers['Prefer'] = req.headers['prefer'];

    try {
      const options = { method: method.toUpperCase(), headers };
      if (['post', 'patch'].includes(method) && req.body) {
        options.body = JSON.stringify(req.body);
      }

      const upstream = await proxyFetch(url, options);
      const text = await upstream.text();

      res.status(upstream.status);
      // Forward Supabase headers that clients may need
      const fwd = ['content-range', 'x-error-message'];
      fwd.forEach((h) => {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      });

      try {
        res.json(JSON.parse(text));
      } catch {
        res.send(text);
      }
    } catch (err) {
      console.error('[supabase]', err.message);
      res.status(502).json({ error: 'Supabase proxy error', detail: err.message });
    }
  });
});

// \u2500\u2500\u2500 Route 4: FRED proxy with 24h cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/fred/*', async (req, res) => {
  const suffix   = req.params[0];
  const qs       = new URLSearchParams({ ...req.query, api_key: FRED_KEY, file_type: 'json' }).toString();
  const cacheKey = `${suffix}|${qs}`;

  const cached = cacheGet(fredCache, cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://api.stlouisfed.org/fred/${suffix}?${qs}`;
    const upstream = await proxyFetch(url);

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();
    cacheSet(fredCache, cacheKey, data, 24 * 60 * 60 * 1000);
    res.json(data);
  } catch (err) {
    console.error('[fred]', err.message);
    res.status(502).json({ error: 'FRED proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 Route 5: Treasury yield curve \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const TREASURY_CSV_URL =
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2024/all?type=daily_treasury_yield_curve&field_tdr_date_value=2024&download=true';

const TREASURY_MATURITIES = [
  '1 Mo', '2 Mo', '3 Mo', '4 Mo', '6 Mo',
  '1 Yr', '2 Yr', '3 Yr', '5 Yr', '7 Yr', '10 Yr', '20 Yr', '30 Yr',
];

function parseTreasuryCsv(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim().replace(/"/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });

  return {
    updated: new Date().toISOString(),
    maturities: TREASURY_MATURITIES,
    rows,
  };
}

app.get('/api/treasury', async (req, res) => {
  const cached = cacheGet(treasuryCache, 'yield');
  if (cached) return res.json(cached);

  // Try current year first, fall back to previous year on failure
  const currentYear = new Date().getFullYear();
  const urls = [currentYear, currentYear - 1].map(
    (yr) =>
      `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&download=true`
  );

  let parsed = null;
  for (const url of urls) {
    try {
      const upstream = await proxyFetch(url);
      if (!upstream.ok) continue;
      const text = await upstream.text();
      parsed = parseTreasuryCsv(text);
      if (parsed) break;
    } catch {
      // try next
    }
  }

  if (parsed) {
    cacheSet(treasuryCache, 'yield', parsed, 24 * 60 * 60 * 1000);
    return res.json(parsed);
  }

  // Serve stale on error
  const stale = cacheGetStale(treasuryCache, 'yield');
  if (stale) {
    console.warn('[treasury] error \u2014 serving stale cache');
    return res.json(stale);
  }

  res.status(502).json({ error: 'Treasury data unavailable' });
});

// \u2500\u2500\u2500 Route 6: RSS proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const RSS_WHITELIST = [
  'feeds.content.dowjones.io',
  'search.cnbc.com',
  'feeds.a.dj.com',
  'rss.cnn.com',
];

function parseRss(xmlText, sourceUrl) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText);

  let items = [];
  let source = sourceUrl;

  // RSS 2.0
  const channel = doc?.rss?.channel;
  if (channel) {
    source = channel.title || source;
    const raw = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    items = raw.map((it) => ({
      title:     it.title     || '',
      url:       it.link      || it.guid || '',
      published: it.pubDate   || '',
    }));
  }

  // Atom
  const feed = doc?.feed;
  if (feed) {
    source = (typeof feed.title === 'string' ? feed.title : feed.title?.['#text']) || source;
    const raw = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
    items = raw.map((it) => {
      let url = '';
      if (it.link) {
        url = typeof it.link === 'string'
          ? it.link
          : (Array.isArray(it.link) ? it.link[0]?.['@_href'] : it.link?.['@_href']) || '';
      }
      return {
        title:     typeof it.title === 'string' ? it.title : it.title?.['#text'] || '',
        url,
        published: it.published || it.updated || '',
      };
    });
  }

  return { items, source };
}

app.get('/api/rss', async (req, res) => {
  const feedUrl = req.query.url;
  if (!feedUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let hostname;
  try {
    hostname = new URL(feedUrl).hostname;
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!RSS_WHITELIST.some((allowed) => hostname === allowed || hostname.endsWith('.' + allowed))) {
    return res.status(403).json({ error: `RSS domain not whitelisted: ${hostname}` });
  }

  const cached = cacheGet(rssCache, feedUrl);
  if (cached) return res.json(cached);

  try {
    const upstream = await proxyFetch(feedUrl, {
      headers: { 'User-Agent': 'FundLens/5.0 support@fundlens.app' },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: 'RSS fetch failed' });

    const text = await upstream.text();
    const parsed = parseRss(text, feedUrl);
    cacheSet(rssCache, feedUrl, parsed, 30 * 60 * 1000);
    res.json(parsed);
  } catch (err) {
    const stale = cacheGetStale(rssCache, feedUrl);
    if (stale) {
      console.warn('[rss] error \u2014 serving stale:', err.message);
      return res.json(stale);
    }
    console.error('[rss]', err.message);
    res.status(502).json({ error: 'RSS proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 Route 7: GDELT proxy (rate-limited to 1 req/5s) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/gdelt', async (req, res) => {
  const now = Date.now();
  if (now - gdeltLastCall < GDELT_MIN_INTERVAL_MS) {
    return res.status(429).json({
      error: 'GDELT rate limit: 1 request per 5 seconds',
      retryAfter: Math.ceil((GDELT_MIN_INTERVAL_MS - (now - gdeltLastCall)) / 1000),
    });
  }

  gdeltLastCall = now;

  const params = new URLSearchParams({
    mode:       'ArtList',
    format:     'json',
    maxrecords: '20',
    timespan:   '24h',   // default to last 24h so articles actually exist
    ...req.query,        // caller overrides (including query string) come after
  });

  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
    const upstream = await proxyFetch(url);

    if (!upstream.ok) {
      const text = await upstream.text();
      console.warn(`[gdelt] upstream ${upstream.status}:`, text.slice(0, 120));
      return res.status(upstream.status).json({ error: text });
    }

    // GDELT occasionally returns an empty body or HTML instead of JSON.
    // Parse text manually so a bad body never causes a 502.
    const text = await upstream.text();
    if (!text || text.trim().length === 0) {
      return res.json({ articles: [] });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn('[gdelt] non-JSON response, returning empty articles:', text.slice(0, 80));
      return res.json({ articles: [] });
    }

    res.json(data);
  } catch (err) {
    console.error('[gdelt]', err.message);
    res.status(502).json({ error: 'GDELT proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 SEC helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const SEC_HEADERS = {
  'User-Agent': 'FundLens/5.0 support@fundlens.app',
  'Accept':     'application/json',
};

async function secProxy(res, url) {
  try {
    const upstream = await proxyFetch(url, { headers: SEC_HEADERS });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }

    const text = await upstream.text();
    try {
      res.json(JSON.parse(text));
    } catch {
      res.setHeader('Content-Type', 'text/xml');
      res.send(text);
    }
  } catch (err) {
    console.error('[sec]', err.message);
    res.status(502).json({ error: 'SEC proxy error', detail: err.message });
  }
}

// \u2500\u2500\u2500 Route 8: EDGAR proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/edgar/*', async (req, res) => {
  const suffix = req.params[0];
  const qs     = new URLSearchParams(req.query).toString();
  const url    = `https://data.sec.gov/${suffix}${qs ? '?' + qs : ''}`;
  await secProxy(res, url);
});

// \u2500\u2500\u2500 Route 9: EFTS (SEC full-text search) proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// edgar.js calls /api/efts/LATEST/search-index \u2014 suffix captures "LATEST/search-index".
// Base URL must NOT include /LATEST/ to avoid doubling the path segment.
app.get('/api/efts/*', async (req, res) => {
  const suffix = req.params[0];
  const qs     = new URLSearchParams(req.query).toString();
  const url    = `https://efts.sec.gov/${suffix}${qs ? '?' + qs : ''}`;
  await secProxy(res, url);
});

// \u2500\u2500\u2500 Route 10: www.sec.gov proxy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/www4sec/*', async (req, res) => {
  const suffix = req.params[0];
  const qs     = new URLSearchParams(req.query).toString();
  const url    = `https://www.sec.gov/${suffix}${qs ? '?' + qs : ''}`;
  await secProxy(res, url);
});

// \u2500\u2500\u2500 Route 11: Finnhub proxy with 24h cache (A14) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// quality.js makes up to 300 Finnhub calls (15 per fund \u00d7 20 funds).
// Free tier = 60/min. Server-side cache prevents repeat fetches within 24h.
// Many funds share top holdings (AAPL, MSFT, NVDA) so same symbols get
// requested across funds \u2014 cache deduplicates these automatically.
app.get('/api/finnhub/*', async (req, res) => {
  const suffix   = req.params[0];
  const qs       = new URLSearchParams({ ...req.query, token: FINNHUB_KEY }).toString();
  const cacheKey = `${suffix}|${qs}`;

  // Serve from cache if fresh (24h TTL)
  const cached = cacheGet(finnhubCache, cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://finnhub.io/api/v1/${suffix}?${qs}`;
    const upstream = await proxyFetch(url);

    if (upstream.status === 429) {
      // Rate limited \u2014 try to serve stale cache if available
      const stale = cacheGetStale(finnhubCache, cacheKey);
      if (stale) {
        console.warn('[finnhub] 429 \u2014 serving stale cache for', cacheKey);
        return res.json(stale);
      }
      return res.status(429).json({ error: 'Finnhub rate limited, no cache available' });
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();
    cacheSet(finnhubCache, cacheKey, data, 24 * 60 * 60 * 1000);  // 24h TTL
    res.json(data);
  } catch (err) {
    // On network error, try to serve stale cache
    const stale = cacheGetStale(finnhubCache, cacheKey);
    if (stale) {
      console.warn('[finnhub] error \u2014 serving stale cache:', err.message);
      return res.json(stale);
    }
    console.error('[finnhub]', err.message);
    res.status(502).json({ error: 'Finnhub proxy error', detail: err.message });
  }
});

// --- Route 11b: OpenFIGI proxy (A13 --- CUSIP-to-ticker resolution) ----------
// cusip.js POSTs batches of up to 100 CUSIPs to OpenFIGI for ticker resolution.
// Free tier: 10 requests/minute, no API key required.
// No server-side cache --- Supabase cusip_ticker_cache handles persistence (90-day TTL).
app.post('/api/openfigi/*', async (req, res) => {
  const suffix = req.params[0];           // e.g. "v3/mapping"
  const url    = `https://api.openfigi.com/${suffix}`;

  try {
    const upstream = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error('[openfigi]', err.message);
    res.status(502).json({ error: 'OpenFIGI proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 Route 12: Twelve Data proxy with 24h cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/twelvedata/*', async (req, res) => {
  if (!TWELVEDATA_KEY) {
    return res.status(503).json({ error: 'TWELVEDATA_KEY not configured' });
  }

  const suffix   = req.params[0];
  const qs       = new URLSearchParams({ ...req.query, apikey: TWELVEDATA_KEY }).toString();
  const cacheKey = `${suffix}|${qs}`;

  const cached = cacheGet(twelveCache, cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://api.twelvedata.com/${suffix}?${qs}`;
    const upstream = await proxyFetch(url);

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: text });
    }

    const data = await upstream.json();
    cacheSet(twelveCache, cacheKey, data, 24 * 60 * 60 * 1000);
    res.json(data);
  } catch (err) {
    console.error('[twelvedata]', err.message);
    res.status(502).json({ error: 'Twelve Data proxy error', detail: err.message });
  }
});

// \u2500\u2500\u2500 Route 13: Health check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function checkService(name, checkFn) {
  const start = Date.now();
  try {
    const result = await checkFn();
    return { [name]: { ok: result.ok, status: result.status, latencyMs: Date.now() - start } };
  } catch (err) {
    return { [name]: { ok: false, error: err.message, latencyMs: Date.now() - start } };
  }
}

app.get('/health', async (req, res) => {
  const checks = await Promise.all([
    checkService('anthropic', () =>
      proxyFetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      })
    ),
    checkService('tiingo', () =>
      proxyFetch('https://api.tiingo.com/api/test/', {
        headers: { Authorization: `Token ${TINNGO_KEY}` },
      })
    ),
    checkService('supabase', () =>
      proxyFetch(`${SUPA_URL}/rest/v1/`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
      })
    ),
    checkService('fred', () =>
      proxyFetch(
        `https://api.stlouisfed.org/fred/series?series_id=FEDFUNDS&api_key=${FRED_KEY}&file_type=json`
      )
    ),
    checkService('finnhub', () =>
      proxyFetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB_KEY}`)
    ),
    checkService('edgar', () =>
      proxyFetch('https://data.sec.gov/submissions/CIK0000002768.json', {
        headers: SEC_HEADERS,
      })
    ),
    checkService('gdelt', () =>
      proxyFetch(
        'https://api.gdeltproject.org/api/v2/doc/doc?query=economy&mode=ArtList&format=json&maxrecords=1&timespan=24h'
      )
    ),
    ...(TWELVEDATA_KEY
      ? [
          checkService('twelvedata', () =>
            proxyFetch(`https://api.twelvedata.com/api_usage?apikey=${TWELVEDATA_KEY}`)
          ),
        ]
      : []),
  ]);

  const merged = Object.assign({}, ...checks);
  const allOk  = Object.values(merged).every((c) => c.ok);

  res.status(allOk ? 200 : 207).json({
    status: allOk ? 'healthy' : 'degraded',
    checks: merged,
    serverTime: new Date().toISOString(),
    tradingDate: todayET(),
  });
});

// \u2500\u2500\u2500 Route 14: SPA catch-all \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// \u2500\u2500\u2500 Start \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.listen(PORT, () => {
  console.log(`[FundLens v5] Server running on port ${PORT}`);
  console.log(`[FundLens v5] Trading date (ET): ${todayET()}`);

  const missing = ['ANTHROPIC_KEY', 'TINNGO_KEY', 'FRED_KEY', 'SUPA_URL', 'SUPA_KEY']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn('[FundLens v5] WARNING \u2014 missing env vars:', missing.join(', '));
  }
});
