// FundLens v4 — EDGAR holdings engine
// Fetches the most recent NPORT-P holdings for a fund from SEC EDGAR.
// Sector mappings are resolved via Claude and cached separately.
//
// Architecture notes:
// - MONEY_MARKET_FUNDS are skipped entirely — no EDGAR call, returns [].
// - Holdings cache TTL: 15 days (NPORT-P filed within 60 days of month-end;
//   15 days catches a new filing within two weeks of it appearing on EDGAR).
// - Sector mapping cache: indefinite (sector_mappings table, no TTL). A stock's
//   GICS sector almost never changes; manual cache invalidation if needed.
// - Claude is used only for sector classification when a ticker is not in cache.
//   Claude calls route through /api/claude (Railway proxy).
// - Never throws — returns [] on any unrecoverable failure.
//
// EDGAR archives path notes (important):
// - Filings are stored under the FILER's CIK, not the fund's own CIK.
//   e.g. FXAIX (fund CIK 819118) is filed by Fidelity Management (CIK 35402);
//   the archives path uses 35402, not 819118.
//   The filer CIK is the first 10-digit segment of the accession number:
//     "0000035402-26-002126" → filer CIK = 35402
// - The primary NPORT-P document is an XML file whose name varies per filer.
//   We discover it by fetching the filing's index JSON first.
//
// Output shape (array of holding objects):
// {
//   ticker:    string,   — holding ticker / CUSIP identifier
//   name:      string,   — issuer name from NPORT-P
//   assetCat:  string,   — EC | DBT | STIV | RF | OTH
//   weight:    number,   — % of fund NAV (0–100)
//   value:     number,   — fair value in USD
//   sector:    string,   — GICS sector (null for non-equity)
//   industry:  string,   — sub-industry (null for non-equity)
// }

import { CLAUDE_MODEL, MONEY_MARKET_FUNDS, GICS_SECTORS } from './constants.js';
import { getHoldings, setHoldings, getSectorMapping, setSectorMapping } from '../services/cache.js';
import { fetchEdgar, fetchSEC } from '../services/api.js';

const SECTOR_BATCH_SIZE  = 20;  // Max tickers sent to Claude per sector request
const MIN_EQUITY_WEIGHT  = 0.1; // % -- skip sector lookup for tiny equity positions

// -- SEC rate limiter ---------------------------------------------------------
// SEC blocks IPs that make too many concurrent requests. This simple queue
// ensures at most 1 SEC request in flight at once, with a 600ms gap between.
//
// FIX (2026-03): The original implementation returned `secQueue` directly,
// which meant any one failed request would poison every subsequent queued
// promise with the same rejection reason. Each caller now gets their own
// independent `result` promise. The shared queue absorbs failures via
// .catch(() => {}) so the chain always advances regardless of individual errors.
let secQueue = Promise.resolve();
function throttledSecRequest(fn) {
  const result = secQueue.then(() => fn());
  secQueue = result
    .catch(() => {})  // absorb error so the queue always continues
    .finally(() => new Promise(r => setTimeout(r, 600)));
  return result;
}

// -- company_tickers_mf.json cache -------------------------------------------
// Single fetch from SEC, cached for the lifetime of the page session.
// Maps ticker -> CIK for all registered mutual funds (~15k entries).
// Eliminates the need for per-ticker EFTS lookups (which were 403-blocked).
let cikMapPromise = null;

async function loadCikMap() {
  if (cikMapPromise) return cikMapPromise;
  cikMapPromise = (async () => {
    try {
      const data = await fetchSEC('/files/company_tickers_mf.json');
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const map = new Map();
      // Primary format: { "fields": ["cik","seriesId","classId","symbol"], "data": [[12345,"S000...","C000...","FXAIX"], ...] }
      // Fallback format: { "0": { "cik": 1234, "symbol": "FXAIX", ... }, ... }
      if (parsed?.fields && Array.isArray(parsed.data)) {
        const fi = {};
        parsed.fields.forEach((f, i) => { fi[f] = i; });
        const cikIdx = fi['cik'] ?? fi['CIK'] ?? 0;
        const symIdx = fi['symbol'] ?? fi['SYMBOL'] ?? 3;
        for (const row of parsed.data) {
          const sym = String(row[symIdx] || '').toUpperCase().trim();
          const cik = row[cikIdx];
          if (sym && cik) map.set(sym, String(cik));
        }
      } else {
        const entries = Object.values(parsed);
        for (const entry of entries) {
          const sym = (entry.symbol || '').toUpperCase().trim();
          if (sym && entry.cik) map.set(sym, String(entry.cik));
        }
      }
      console.log(`[edgar] Loaded CIK map: ${map.size} mutual fund tickers`);
      return map;
    } catch (err) {
      console.warn('[edgar] Failed to load company_tickers_mf.json:', err.message);
      return new Map();
    }
  })();
  return cikMapPromise;
}

// -- CIK lookup ---------------------------------------------------------------
// Primary: company_tickers_mf.json (single fetch, cached for session).
// Fallback: browse-edgar Atom feed (one request per ticker, throttled).
// EFTS full-text search removed -- returns 403 from Railway IPs since Mar 2026.
async function getCik(ticker) {
  // Attempt 1: cached CIK map (covers ~15k mutual fund tickers)
  const cikMap = await loadCikMap();
  const mapped = cikMap.get(ticker.toUpperCase());
  if (mapped) return mapped;

  // Attempt 2: browse-edgar Atom feed (throttled to avoid WAF)
  try {
    const xml = await throttledSecRequest(() =>
      fetchSEC(
        `/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=NPORT-P&dateb=&owner=include&count=1&search_text=&output=atom`
      )
    );

    const cikMatch = xml.match(/<cik[^>]*>0*(\d+)<\/cik>/i);
    if (cikMatch) return cikMatch[1];

    const linkMatch = xml.match(/CIK=0*(\d+)/);
    if (linkMatch) return linkMatch[1];
  } catch (err) {
    console.warn(`[edgar] browse-edgar fallback failed for ${ticker}:`, err.message);
  }

  console.warn(`[edgar] Could not resolve CIK for ${ticker}`);
  return null;
}

// ── Latest NPORT-P accession ──────────────────────────────────────────────────
// Given a CIK, find the most recent NPORT-P filing accession number.
async function getLatestNportAccession(cik) {
  try {
    const data = await throttledSecRequest(() =>
      fetchEdgar(`/submissions/CIK${cik.padStart(10, '0')}.json`)
    );
    const filings = data?.filings?.recent;
    if (!filings) return null;

    const forms = filings.form ?? [];
    const accessions = filings.accessionNumber ?? [];

    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === 'NPORT-P') {
        return accessions[i]; // e.g. "0001752724-24-123456"
      }
    }
    return null;
  } catch (err) {
    console.warn(`[edgar] Accession lookup failed for CIK ${cik}:`, err.message);
    return null;
  }
}

// ── Parse holdings from NPORT-P XML ──────────────────────────────────────────
// Uses DOMParser (browser-native) to extract invstOrSec elements.
// NPORT-P XML schema: each holding is an <invstOrSec> with child elements
// for name, identifiers (ticker/isin/cusip), assetCat, valUSD, pctVal.
function parseHoldingsFromXml(xmlText) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');

    // Abort on malformed XML
    if (doc.querySelector('parsererror')) {
      console.warn('[edgar] XML parse error in NPORT-P document');
      return [];
    }

    // Total assets for weight calculation
    const totAssetsEl =
      doc.querySelector('totAssets') ||
      doc.querySelector('totalAssets');
    const totalNav = totAssetsEl ? parseFloat(totAssetsEl.textContent) : 0;

    const holdings = [];
    const invstEls = doc.querySelectorAll('invstOrSec');

    for (const inv of invstEls) {
      const name = inv.querySelector('name')?.textContent?.trim() || '';

      // Ticker lookup order: identifiers block → direct ticker → isin → cusip
      const ticker =
        inv.querySelector('identifiers ticker')?.textContent?.trim() ||
        inv.querySelector('ticker')?.textContent?.trim() ||
        inv.querySelector('isin')?.textContent?.trim() ||
        inv.querySelector('cusip')?.textContent?.trim() ||
        '';

      const assetCat = (inv.querySelector('assetCat')?.textContent?.trim() || 'OTH').toUpperCase();

      const valUSD = parseFloat(inv.querySelector('valUSD')?.textContent || '0');
      const pctVal = parseFloat(inv.querySelector('pctVal')?.textContent || '0');

      // Prefer valUSD for value; use pctVal directly as weight when NAV unavailable
      const value  = !isNaN(valUSD) && valUSD > 0 ? valUSD : 0;
      const weight = totalNav > 0 && value > 0
        ? (value / totalNav) * 100
        : (!isNaN(pctVal) ? pctVal : 0);

      if (!name && !ticker) continue;
      if (value <= 0 && weight <= 0) continue;

      holdings.push({
        ticker:   ticker,
        name:     name,
        assetCat,
        weight:   Math.round(weight * 10000) / 10000,
        value:    Math.round(value * 100) / 100,
        sector:   null,
        industry: null,
      });
    }

    holdings.sort((a, b) => b.weight - a.weight);
    return holdings;
  } catch (err) {
    console.warn('[edgar] XML holdings parse failed:', err.message);
    return [];
  }
}

// ── Sector classification via Claude ─────────────────────────────────────────
// Sends a batch of equity tickers to Claude and returns a sector map.
// Only called for tickers not already in the sector_mappings cache.
async function classifySectorsBatch(tickers) {
  if (!tickers.length) return {};

  const knownSectors = Object.keys(GICS_SECTORS).join(', ');
  const prompt = `You are a financial data assistant. Classify each stock ticker into its GICS sector.

Valid sectors: ${knownSectors}

Tickers to classify: ${tickers.join(', ')}

Respond ONLY with a JSON object mapping each ticker to its sector. No preamble, no markdown.
If a ticker is unknown or not a stock, use null.

Example: { "AAPL": "Technology", "JPM": "Financials", "XYZ_UNKNOWN": null }`;

  try {
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data  = await res.json();
    const text  = (data.content || []).map(b => b.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.warn('[edgar] Sector classification failed:', err.message);
    return {};
  }
}

// ── Resolve sectors for all equity holdings ───────────────────────────────────
// Checks cache first, batches cache misses to Claude, persists results.
async function resolveHoldingSectors(holdings) {
  // Only classify equity positions above the minimum weight threshold
  const equityHoldings = holdings.filter(
    h => h.assetCat === 'EC' && h.weight >= MIN_EQUITY_WEIGHT && h.ticker
  );

  if (!equityHoldings.length) return holdings;

  // Check cache for each ticker
  const uncached = [];
  const sectorMap = {};

  await Promise.all(equityHoldings.map(async (h) => {
    try {
      const cached = await getSectorMapping(h.ticker);
      if (cached) {
        sectorMap[h.ticker] = { sector: cached.sector, industry: cached.industry };
      } else {
        uncached.push(h.ticker);
      }
    } catch {
      uncached.push(h.ticker);
    }
  }));

  // Batch uncached tickers to Claude in groups of SECTOR_BATCH_SIZE
  for (let i = 0; i < uncached.length; i += SECTOR_BATCH_SIZE) {
    const batch   = uncached.slice(i, i + SECTOR_BATCH_SIZE);
    const results = await classifySectorsBatch(batch);

    await Promise.all(batch.map(async (ticker) => {
      const sector = results[ticker] ?? null;
      sectorMap[ticker] = { sector, industry: null };
      if (sector) {
        try {
          await setSectorMapping(ticker, sector, null);
        } catch (err) {
          console.warn(`[edgar] Sector cache write failed for ${ticker}:`, err.message);
        }
      }
    }));
  }

  // Apply resolved sectors back to holdings array
  return holdings.map(h => {
    if (sectorMap[h.ticker]) {
      return { ...h, sector: sectorMap[h.ticker].sector, industry: sectorMap[h.ticker].industry };
    }
    return h;
  });
}

// ── Public entry point ────────────────────────────────────────────────────────
// Returns array of holding objects (see shape at top of file).
// Returns [] for money market funds, and on any unrecoverable error.
export async function fetchHoldings(ticker, fundName) {
  // Skip EDGAR entirely for money market funds
  if (MONEY_MARKET_FUNDS.has(ticker)) {
    return [];
  }

  // Check Supabase cache (15-day TTL enforced by getHoldings)
  try {
    const cached = await getHoldings(ticker);
    if (cached?.length) {
      return cached;
    }
  } catch (err) {
    console.warn(`[edgar] Cache read failed for ${ticker}:`, err.message);
  }

  // Look up CIK
  const cik = await getCik(ticker);
  if (!cik) {
    console.warn(`[edgar] Could not resolve CIK for ${ticker}`);
    return [];
  }

  // Get latest NPORT-P accession number
  const accession = await getLatestNportAccession(cik);
  if (!accession) {
    console.warn(`[edgar] No NPORT-P filing found for ${ticker} (CIK ${cik})`);
    return [];
  }

  // ── Fetch NPORT-P filing data ───────────────────────────────────────────
  // EDGAR archives files under the FILER's CIK, not the fund's own CIK.
  // The filer CIK is the first numeric segment of the accession number:
  //   "0000035402-26-002126" → filerCik = "35402"
  // FXAIX (fund CIK 819118) is filed by Fidelity Management (CIK 35402),
  // so the archives path uses 35402. Using the fund CIK gives 404 every time.
  //
  // The primary holdings document is an XML file with a filer-specific name
  // (e.g. "primary_doc.xml", "nportholdings.xml"). We discover the filename
  // from the filing's index JSON, then fetch and parse the XML with DOMParser.
  // xbrl_data.json is not a real EDGAR file and never existed.
  let holdings = [];
  try {
    const accessionClean = accession.replace(/-/g, '');
    const filerCik       = String(parseInt(accession.split('-')[0], 10));

    // Step 1: Fetch filing index JSON to find the primary XML document name.
    // Index path: /Archives/edgar/data/{filerCik}/{accNoDash}/{accWithDash}-index.json
    let primaryDocName = null;
    try {
      const indexData = await throttledSecRequest(() =>
        fetchEdgar(`/Archives/edgar/data/${filerCik}/${accessionClean}/${accession}-index.json`)
      );
      const files = Array.isArray(indexData?.files) ? indexData.files : [];
      // Primary doc: type "NPORT-P", or first .xml that is not a schema (.xsd)
      const primary = files.find(f =>
        f.type === 'NPORT-P' ||
        (f.name && /\.xml$/i.test(f.name) && !/\.xsd$/i.test(f.name))
      );
      primaryDocName = primary?.name || null;
    } catch (err) {
      console.warn(`[edgar] Index fetch failed for ${ticker} (filer ${filerCik}/${accessionClean}):`, err.message);
    }

    if (!primaryDocName) {
      console.warn(`[edgar] No primary XML found in filing index for ${ticker} (filer ${filerCik})`);
      return [];
    }

    // Step 2: Fetch the primary XML as raw text via the /api/edgar proxy.
    // fetchEdgar always parses JSON so we use raw fetch here for text/xml.
    const xmlText = await throttledSecRequest(() =>
      fetch(`/api/edgar/Archives/edgar/data/${filerCik}/${accessionClean}/${primaryDocName}`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
    );

    // Step 3: Parse NPORT-P XML holdings with DOMParser.
    holdings = parseHoldingsFromXml(xmlText);

  } catch (err) {
    console.warn(`[edgar] NPORT-P fetch failed for ${ticker} (accession ${accession}):`, err.message);
    return [];
  }

  if (!holdings.length) {
    console.warn(`[edgar] No holdings parsed for ${ticker}`);
    return [];
  }

  // Resolve GICS sectors for equity holdings
  holdings = await resolveHoldingSectors(holdings);

  // Persist to Supabase cache
  try {
    await setHoldings(ticker, holdings);
  } catch (err) {
    console.warn(`[edgar] Cache write failed for ${ticker}:`, err.message);
    // Non-fatal — return holdings even if cache write fails
  }

  return holdings;
}
