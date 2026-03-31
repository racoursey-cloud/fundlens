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
// EDGAR proxy routing (two different hosts):
//   /api/edgar   → https://data.sec.gov   — submissions JSON, CIK maps
//   /api/www4sec → https://www.sec.gov    — filing archives (XML documents)
//
// Primary document discovery:
//   The submissions/CIK*.json response includes a `primaryDocument` array
//   alongside `accessionNumber` and `form`. No separate index.json fetch needed.
//   Index JSON files (e.g. {accession}-index.json) are not reliably present
//   on www.sec.gov and should not be used.
//
// EDGAR archives path:
//   Filings are stored under the FILER's CIK, not the fund's CIK.
//   Filer CIK = first numeric segment of the accession number:
//     "0000035402-26-002126" → filer CIK = 35402
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
// Each caller gets its own independent `result` promise. The shared queue
// absorbs failures so the chain always advances.
let secQueue = Promise.resolve();
function throttledSecRequest(fn) {
  const result = secQueue.then(() => fn());
  secQueue = result
    .catch(() => {})
    .finally(() => new Promise(r => setTimeout(r, 600)));
  return result;
}

// -- company_tickers_mf.json cache -------------------------------------------
let cikMapPromise = null;

async function loadCikMap() {
  if (cikMapPromise) return cikMapPromise;
  cikMapPromise = (async () => {
    try {
      const data = await fetchSEC('/files/company_tickers_mf.json');
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const map = new Map();
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
async function getCik(ticker) {
  const cikMap = await loadCikMap();
  const mapped = cikMap.get(ticker.toUpperCase());
  if (mapped) return mapped;

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

// ── Latest NPORT-P accession + primary document name ─────────────────────────
// The submissions API response includes `primaryDocument[]` alongside
// `accessionNumber[]` and `form[]`. We read the primary XML filename here
// so no separate index.json fetch is needed.
// Returns { accession, primaryDoc } or null.
async function getLatestNportFiling(cik) {
  try {
    const data = await throttledSecRequest(() =>
      fetchEdgar(`/submissions/CIK${cik.padStart(10, '0')}.json`)
    );
    const filings = data?.filings?.recent;
    if (!filings) return null;

    const forms       = filings.form            ?? [];
    const accessions  = filings.accessionNumber ?? [];
    const primaryDocs = filings.primaryDocument  ?? [];

    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === 'NPORT-P') {
        return {
          accession:  accessions[i],   // e.g. "0001410368-26-026282"
          primaryDoc: primaryDocs[i],  // e.g. "primary_doc.xml"
        };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[edgar] Submissions lookup failed for CIK ${cik}:`, err.message);
    return null;
  }
}

// ── Parse holdings from NPORT-P XML ──────────────────────────────────────────
function parseHoldingsFromXml(xmlText) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');

    if (doc.querySelector('parsererror')) {
      console.warn('[edgar] XML parse error in NPORT-P document');
      return [];
    }

    const totAssetsEl =
      doc.querySelector('totAssets') ||
      doc.querySelector('totalAssets');
    const totalNav = totAssetsEl ? parseFloat(totAssetsEl.textContent) : 0;

    const holdings = [];
    const invstEls = doc.querySelectorAll('invstOrSec');

    for (const inv of invstEls) {
      const name = inv.querySelector('name')?.textContent?.trim() || '';

      const ticker =
        inv.querySelector('identifiers ticker')?.textContent?.trim() ||
        inv.querySelector('ticker')?.textContent?.trim() ||
        inv.querySelector('isin')?.textContent?.trim() ||
        inv.querySelector('cusip')?.textContent?.trim() ||
        '';

      const assetCat = (inv.querySelector('assetCat')?.textContent?.trim() || 'OTH').toUpperCase();

      const valUSD = parseFloat(inv.querySelector('valUSD')?.textContent || '0');
      const pctVal = parseFloat(inv.querySelector('pctVal')?.textContent || '0');

      const value  = !isNaN(valUSD) && valUSD > 0 ? valUSD : 0;
      const weight = totalNav > 0 && value > 0
        ? (value / totalNav) * 100
        : (!isNaN(pctVal) ? pctVal : 0);

      if (!name && !ticker) continue;
      if (value <= 0 && weight <= 0) continue;

      holdings.push({
        ticker,
        name,
        assetCat,
        weight: Math.round(weight * 10000) / 10000,
        value:  Math.round(value * 100) / 100,
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
async function resolveHoldingSectors(holdings) {
  const equityHoldings = holdings.filter(
    h => h.assetCat === 'EC' && h.weight >= MIN_EQUITY_WEIGHT && h.ticker
  );
  if (!equityHoldings.length) return holdings;

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

  return holdings.map(h => {
    if (sectorMap[h.ticker]) {
      return { ...h, sector: sectorMap[h.ticker].sector, industry: sectorMap[h.ticker].industry };
    }
    return h;
  });
}

// ── Public entry point ────────────────────────────────────────────────────────
export async function fetchHoldings(ticker, fundName) {
  if (MONEY_MARKET_FUNDS.has(ticker)) return [];

  try {
    const cached = await getHoldings(ticker);
    if (cached?.length) return cached;
  } catch (err) {
    console.warn(`[edgar] Cache read failed for ${ticker}:`, err.message);
  }

  const cik = await getCik(ticker);
  if (!cik) {
    console.warn(`[edgar] Could not resolve CIK for ${ticker}`);
    return [];
  }

  // Get accession number AND primary doc name from submissions API in one call.
  // No separate index.json fetch needed — primaryDocument[] is in submissions.
  const filing = await getLatestNportFiling(cik);
  if (!filing) {
    console.warn(`[edgar] No NPORT-P filing found for ${ticker} (CIK ${cik})`);
    return [];
  }

  const { accession, primaryDoc } = filing;

  if (!primaryDoc) {
    console.warn(`[edgar] No primaryDocument in submissions for ${ticker} (accession ${accession})`);
    return [];
  }

  // ── Fetch NPORT-P XML ────────────────────────────────────────────────────
  // Archives live on www.sec.gov — use /api/www4sec proxy.
  // Filer CIK = first numeric segment of accession: "0000035402-26-002126" → 35402
  let holdings = [];
  try {
    const accessionClean = accession.replace(/-/g, '');
    const filerCik       = String(parseInt(accession.split('-')[0], 10));
    const xmlUrl         = `/api/www4sec/Archives/edgar/data/${filerCik}/${accessionClean}/${primaryDoc}`;

    const xmlText = await throttledSecRequest(() =>
      fetch(xmlUrl).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    );

    holdings = parseHoldingsFromXml(xmlText);
  } catch (err) {
    console.warn(`[edgar] NPORT-P fetch failed for ${ticker} (accession ${accession}):`, err.message);
    return [];
  }

  if (!holdings.length) {
    console.warn(`[edgar] No holdings parsed for ${ticker}`);
    return [];
  }

  holdings = await resolveHoldingSectors(holdings);

  try {
    await setHoldings(ticker, holdings);
  } catch (err) {
    console.warn(`[edgar] Cache write failed for ${ticker}:`, err.message);
  }

  return holdings;
}
