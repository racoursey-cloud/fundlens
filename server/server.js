// FundLens v4 — Railway proxy server
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const TINNGO_KEY     = process.env.TINNGO_KEY;
const FRED_KEY       = process.env.FRED_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY;
const SUPA_URL       = process.env.SUPA_URL;
const SUPA_KEY       = process.env.SUPA_KEY;
const SUPA_ANON_KEY  = process.env.SUPA_ANON_KEY;

app.use(express.json({ limit: '2mb' }));

async function proxyFetch(req, res, url, extraHeaders = {}) {
  try {
    const opts = { method: req.method, headers: { ...extraHeaders }, signal: AbortSignal.timeout(35000) };
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.body && Object.keys(req.body).length) {
      opts.body = JSON.stringify(req.body);
    }
    ['prefer','content-type','range'].forEach(h => { if (req.headers[h]) opts.headers[h] = req.headers[h]; });
    const upstream = await fetch(url, opts);
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!['transfer-encoding','content-encoding','content-length','connection','keep-alive'].includes(k.toLowerCase())) res.setHeader(k, v);
    });
    res.send(await upstream.text());
  } catch (e) {
    res.status(502).json({ error: 'Upstream request failed', detail: e.message });
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '4.0.0' }));

app.post('/api/claude', (req, res) =>
  proxyFetch(req, res, 'https://api.anthropic.com/v1/messages', {
    'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
  })
);

app.all('/api/tiingo/*', (req, res) => {
  const up = req.path.replace('/api/tiingo', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://api.tiingo.com${up}${qs}`, { Authorization: `Token ${TINNGO_KEY}`, 'Content-Type': 'application/json' });
});

app.all('/api/fred/*', (req, res) => {
  const up = req.path.replace('/api/fred', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const sep = qs ? '&' : '?';
  proxyFetch(req, res, `https://api.stlouisfed.org/fred${up}${qs}${sep}api_key=${FRED_KEY}&file_type=json`);
});

app.all('/api/supabase/*', (req, res) => {
  const up = req.path.replace('/api/supabase', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `${SUPA_URL}/rest/v1${up}${qs}`, { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' });
});

app.all('/api/gdelt', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://api.gdeltproject.org/api/v2/doc/doc${qs}`);
});

app.all('/api/edgar/*', (req, res) => {
  const up = req.path.replace('/api/edgar', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://data.sec.gov/submissions${up}${qs}`, { 'User-Agent': 'FundLens/4.0 admin@fundlens.app', Accept: 'application/json' });
});

app.all('/api/efts/*', (req, res) => {
  const up = req.path.replace('/api/efts', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://efts.sec.gov/LATEST${up}${qs}`, { 'User-Agent': 'FundLens/4.0 admin@fundlens.app' });
});

app.all('/api/www4sec/*', (req, res) => {
  const up = req.path.replace('/api/www4sec', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyFetch(req, res, `https://www.sec.gov${up}${qs}`, { 'User-Agent': 'FundLens/4.0 admin@fundlens.app', Accept: '*/*' });
});

app.all('/api/twelvedata/*', (req, res) => {
  const up = req.path.replace('/api/twelvedata', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const sep = qs ? '&' : '?';
  proxyFetch(req, res, `https://api.twelvedata.com${up}${qs}${sep}apikey=${TWELVEDATA_KEY}`);
});

app.get('/api/treasury', async (req, res) => {
  try {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}`;
    const r = await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${ym}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(r.status).json({ error: 'Treasury fetch failed' });
    const xml = await r.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
    if (!entries.length) return res.json({});
    const latest = entries[entries.length-1];
    const getVal = tag => { const m = latest.match(new RegExp(`<d:${tag}[^>]*>([^<]+)<`)); return m ? parseFloat(m[1]) : null; };
    res.json({ date: latest.match(/<d:NEW_DATE[^>]*>([^<T]+)/)?.[1]?.trim()||null, y1:getVal('BC_1YEAR'), y2:getVal('BC_2YEAR'), y5:getVal('BC_5YEAR'), y10:getVal('BC_10YEAR'), y30:getVal('BC_30YEAR') });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FundLens/4.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(r.status).send('');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(await r.text());
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── /api/devinfo ─────────────────────────────────────────────────────────────
// Development health + schema inspection endpoint.
// Protected by DEVINFO_TOKEN env var (set in Railway dashboard).
// Usage: /api/devinfo?key=<DEVINFO_TOKEN>
app.get('/api/devinfo', async (req, res) => {
  const token = process.env.DEVINFO_TOKEN;
  if (token && req.query.key !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const pgHeaders = {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      Accept: 'application/json',
    };
    const [tablesRes, columnsRes] = await Promise.all([
      fetch(`${SUPA_URL}/pg/tables?limit=50`,  { headers: pgHeaders, signal: AbortSignal.timeout(8000) }),
      fetch(`${SUPA_URL}/pg/columns?limit=200`, { headers: pgHeaders, signal: AbortSignal.timeout(8000) }),
    ]);
    const tables  = tablesRes.ok  ? await tablesRes.json()  : { error: `${tablesRes.status}` };
    const columns = columnsRes.ok ? await columnsRes.json() : { error: `${columnsRes.status}` };

    const publicTables = Array.isArray(tables)
      ? tables.filter(t => t.schema === 'public').map(t => t.name)
      : tables;

    const schemaMap = Array.isArray(columns)
      ? columns
          .filter(c => c.schema === 'public')
          .reduce((acc, c) => {
            if (!acc[c.table]) acc[c.table] = [];
            acc[c.table].push({ column: c.name, type: c.format, nullable: c.is_nullable });
            return acc;
          }, {})
      : columns;

    res.json({
      status:  'ok',
      version: '4.0.0',
      env: {
        ANTHROPIC_KEY:  !!process.env.ANTHROPIC_KEY,
        TINNGO_KEY:     !!process.env.TINNGO_KEY,
        FRED_KEY:       !!process.env.FRED_KEY,
        TWELVEDATA_KEY: !!process.env.TWELVEDATA_KEY,
        SUPA_URL:       !!process.env.SUPA_URL,
        SUPA_KEY:       !!process.env.SUPA_KEY,
        SUPA_ANON_KEY:  !!process.env.SUPA_ANON_KEY,
        NODE_ENV:       process.env.NODE_ENV,
      },
      tables: publicTables,
      schema: schemaMap,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

const distPath = join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => { res.sendFile(join(distPath, 'index.html')); });
app.listen(PORT, () => { console.log(`FundLens v4 running on port ${PORT}`); });
