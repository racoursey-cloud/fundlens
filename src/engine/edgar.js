// src/engine/edgar.js
// Fetches fund holdings from SEC EDGAR NPORT-P filings for all fund tickers.
// Results are cached in Supabase holdings_cache (15-day TTL).
//
// 3-strategy CIK resolution per ticker:
//   1. MF tickers file  — /api/www4sec/files/company_tickers_mf.json (array-of-arrays)
//   2. EFTS full-text search — /api/efts/LATEST/search-index
//   3. Skip (log warning, return empty)
//
// ⚠️  All Supabase calls route through cache.js helpers (supaFetch under the hood).
// ⚠️  No localStorage. No direct Supabase calls.
// ⚠️  300ms delay between tickers (SEC rate ~10 req/sec).
// ⚠️  CRITICAL: company_tickers_mf.json uses { fields, data } array-of-arrays
//     format — iterate data[][] using field index positions, NOT object keys.

import { getHoldings, saveHoldings } from '../services/cache.js';
import { MONEY_MARKET_TICKERS }       from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DELAY_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Zero-pads a CIK to 10 digits and prepends "CIK".
 * e.g. "12345" → "CIK0000012345"
 */
function formatCIK(cik) {
  return 'CIK' + String(cik).replace(/^CIK/i, '').padStart(10, '0');
}

/**
 * Strips the "CIK" prefix and any leading zeros to get the bare numeric CIK.
 * e.g. "CIK0000012345" → "12345"
 */
function bareCIK(cik) {
  return String(cik).replace(/^CIK0*/i, '') || '0';
}

/**
 * Removes dashes from an accession number.
 * e.g. "0001234567-23-001234" → "000123456723001234"
 */
function stripDashes(accNo) {
  return accNo.replace(/-/g, '');
}

/**
 * Reads a single text value from the first matching XML element.
 */
function xmlText(parent, tagName) {
  const el = parent.querySelector(tagName);
  return el ? (el.textContent || '').trim() : null;
}

// ---------------------------------------------------------------------------
// Module-level CIK map cache (loaded once per session)
// ---------------------------------------------------------------------------

let _cikMapCache = null;  // Map<string, string>  ticker (uppercase) → CIK string

/**
 * Loads the SEC mutual fund CIK map from the Railway proxy (once per session).
 *
 * The endpoint returns one of two formats:
 *
 *   Format A (array-of-arrays) — the primary format:
 *     { "fields": ["cik_str", "ticker", "title", ...], "data": [[12345, "FXAIX", ...], ...] }
 *
 *   Format B (object-of-objects) — legacy fallback:
 *     { "0": { "cik_str": 12345, "ticker": "FXAIX", ... }, "1": { ... }, ... }
 *
 * Returns a Map<TICKER_UPPERCASE, CIK_STRING>.
 */
async function loadCIKMap() {
  if (_cikMapCache) return _cikMapCache;

  const map = new Map();

  try {
    const res = await fetch('/api/www4sec/files/company_tickers_mf.json');
    if (!res.ok) {
      console.warn(`[edgar] CIK map fetch failed — HTTP ${res.status}`);
      _cikMapCache = map;
      return map;
    }

    const json = await res.json();

    // ── Format A: { fields: [...], data: [[...], ...] } ──────────────────
    if (Array.isArray(json.fields) && Array.isArray(json.data)) {
      const fields = json.fields.map(f => String(f).toLowerCase());
      const cikIdx    = fields.indexOf('cik_str');
      const tickerIdx = fields.indexOf('ticker');

      if (cikIdx === -1 || tickerIdx === -1) {
        console.warn('[edgar] CIK map fields missing cik_str or ticker:', fields);
      } else {
        for (const row of json.data) {
          if (!Array.isArray(row)) continue;
          const cik    = row[cikIdx];
          const ticker = row[tickerIdx];
          if (cik != null && ticker) {
            map.set(String(ticker).toUpperCase(), String(cik));
          }
        }
      }

      console.log(`[edgar] CIK map loaded (array format): ${map.size} entries`);
      _cikMapCache = map;
      return map;
    }

    // ── Format B: { "0": { cik_str, ticker, ... }, ... } ─────────────────
    if (typeof json === 'object' && json !== null) {
      for (const entry of Object.values(json)) {
        const cik    = entry.cik_str ?? entry.cik;
        const ticker = entry.ticker;
        if (cik != null && ticker) {
          map.set(String(ticker).toUpperCase(), String(cik));
        }
      }

      console.log(`[edgar] CIK map loaded (object format): ${map.size} entries`);
      _cikMapCache = map;
      return map;
    }

    console.warn('[edgar] CIK map unrecognised format:', typeof json);
  } catch (err) {
    console.warn('[edgar] CIK map load error:', err.message);
  }

  _cikMapCache = map;
  return map;
}

// ---------------------------------------------------------------------------
// CIK resolution via EFTS full-text search (fallback)
// ---------------------------------------------------------------------------

/**
 * Attempts to find a CIK for `ticker` via EFTS full-text search for NPORT-P.
 * Returns a CIK string or null.
 */
async function resolveCIKviaEFTS(ticker) {
  try {
    const url = `/api/efts/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&forms=NPORT-P`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const json = await res.json();

    // EFTS returns { hits: { hits: [{ _source: { period_of_report, entity_name, file_num, ... }, _id: "..." }, ...] } }
    // The CIK is embedded in the accession number or in _source fields.
    const hits = json?.hits?.hits ?? json?.hits ?? [];
    if (!Array.isArray(hits) || hits.length === 0) return null;

    const first = hits[0];

    // Try _source.entity_id or _source.period_of_report as a CIK clue.
    // Most reliable: extract CIK from the accession number (_id or file_date).
    // Accession numbers are formatted as {cik}-{year}-{seq}.
    const id = first._id ?? first.accession_no ?? '';
    const match = String(id).match(/^(\d+)-\d{2}-\d+/);
    if (match) return match[1];

    // Secondary: check _source directly
    const src = first._source ?? first;
    if (src.cik)    return String(src.cik);
    if (src.cik_str) return String(src.cik_str);

    return null;
  } catch (err) {
    console.warn(`[edgar] EFTS CIK lookup failed for ${ticker}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// NPORT-P submission lookup
// ---------------------------------------------------------------------------

/**
 * Fetches the submissions JSON for a CIK and returns the most recent NPORT-P
 * accession number (with dashes, e.g. "0001234567-23-001234"), or null.
 */
async function fetchLatestNportAccNo(cik) {
  try {
    const paddedCIK = formatCIK(cik);
    const url = `/api/edgar/submissions/${paddedCIK}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const json = await res.json();
    const recent = json?.filings?.recent;
    if (!recent) return null;

    const forms      = recent.form        ?? [];
    const accNumbers = recent.accessionNumber ?? [];

    // Walk forms array to find the first NPORT-P
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === 'NPORT-P') {
        return accNumbers[i] ?? null;
      }
    }
    return null;
  } catch (err) {
    console.warn(`[edgar] submissions fetch error for CIK ${cik}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// NPORT-P filing index + XML fetch
// ---------------------------------------------------------------------------

/**
 * Fetches the EDGAR filing index HTML for the given CIK + accession number
 * and returns the URL of the primary NPORT-P XML document, or null.
 *
 * Index page:  /Archives/edgar/data/{cik}/{accNoDashes}/
 * We look for .xml files and prefer the one that is NOT the schema/cal/pre/lab
 * (i.e. the primary report document).
 */
async function fetchPrimaryXmlUrl(cik, accNoDashes) {
  try {
    const bare = bareCIK(cik);
    const indexUrl = `/api/www4sec/Archives/edgar/data/${bare}/${accNoDashes}/`;
    const res = await fetch(indexUrl);
    if (!res.ok) return null;

    const html = await res.text();

    // Parse the directory listing HTML for .xml links.
    const parser = new DOMParser();
    const doc    = parser.parseFromString(html, 'text/html');

    const links = Array.from(doc.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(href => href && href.toLowerCase().endsWith('.xml'));

    if (links.length === 0) return null;

    // Prefer the primary NPORT document.
    // Scoring heuristic (higher = better):
    //   - name contains "nport" or "primary" or matches accession basename → top
    //   - shorter names are often the primary document
    //   - avoid schema files (_cal, _lab, _pre, _def)
    const scored = links.map(href => {
      const name = href.split('/').pop().toLowerCase();
      let score = 0;
      if (name.includes('nport'))    score += 10;
      if (name.includes('primary'))  score += 8;
      if (name.includes('_cal') || name.includes('_lab') ||
          name.includes('_pre') || name.includes('_def')) score -= 20;
      // Prefer shorter filenames (the main report is often just {accno}.xml)
      score -= name.length * 0.1;
      return { href, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].href;

    // Resolve relative URL: if href is absolute use as-is, else prepend base.
    if (best.startsWith('http')) return best;
    if (best.startsWith('/')) return `/api/www4sec${best}`;
    return `${indexUrl}${best}`;
  } catch (err) {
    console.warn(`[edgar] index fetch error for ${cik}/${accNoDashes}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// NPORT-P XML parser
// ---------------------------------------------------------------------------

/**
 * Fetches and parses a NPORT-P XML document.
 * Returns an array of holding objects sorted by pctVal descending (top 200).
 *
 * Each holding:
 *   { holding_name, holding_ticker, weight, market_value, asset_type, sector }
 *
 * pctVal is already a percentage (5.2 = 5.2% — stored as weight directly).
 */
async function parseNportXml(xmlUrl) {
  try {
    const res = await fetch(xmlUrl);
    if (!res.ok) return [];

    const text = await res.text();
    if (!text || text.length < 100) return [];

    const parser  = new DOMParser();
    const xmlDoc  = parser.parseFromString(text, 'text/xml');

    // Check for parse errors
    const parseErr = xmlDoc.querySelector('parsererror');
    if (parseErr) {
      console.warn('[edgar] XML parse error:', parseErr.textContent?.slice(0, 200));
      return [];
    }

    // <invstOrSec> blocks contain individual holdings
    const securities = xmlDoc.querySelectorAll('invstOrSec');
    if (!securities || securities.length === 0) return [];

    const holdings = [];

    for (const sec of securities) {
      const name       = xmlText(sec, 'name');
      const pctValStr  = xmlText(sec, 'pctVal');
      const valUSDStr  = xmlText(sec, 'valUSD');
      const assetCat   = xmlText(sec, 'assetCat');

      // Ticker lives inside <identifiers><ticker> or <ticker>
      const identifiers   = sec.querySelector('identifiers');
      const tickerEl      = identifiers
        ? identifiers.querySelector('ticker')
        : sec.querySelector('ticker');
      const holdingTicker = tickerEl ? tickerEl.textContent.trim() : null;

      const pctVal  = pctValStr  ? parseFloat(pctValStr)  : null;
      const valUSD  = valUSDStr  ? parseFloat(valUSDStr)  : null;

      // Skip rows with no name or weight
      if (!name || pctVal == null || isNaN(pctVal)) continue;

      holdings.push({
        holding_name:   name,
        holding_ticker: holdingTicker || null,
        weight:         pctVal,
        market_value:   (!isNaN(valUSD) ? valUSD : null),
        asset_type:     assetCat || null,
        sector:         null,  // sector enriched later by sector mapping engine
      });
    }

    // Sort by weight descending, take top 200
    holdings.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    return holdings.slice(0, 200);
  } catch (err) {
    console.warn('[edgar] XML fetch/parse error:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-ticker fetch orchestrator
// ---------------------------------------------------------------------------

/**
 * Fetches NPORT-P holdings for a single ticker.
 * Tries CIK map → submissions → archive XML.
 * Falls back to EFTS if CIK not found in map.
 * Returns an array of holding objects (may be empty on failure).
 */
async function fetchHoldingsForTicker(ticker, cikMap) {
  // ── 1. Look up CIK from the MF tickers map ───────────────────────────────
  let cik = cikMap.get(ticker.toUpperCase()) ?? null;

  // ── 2. EFTS fallback ─────────────────────────────────────────────────────
  if (!cik) {
    console.log(`[edgar] ${ticker} not in CIK map — trying EFTS`);
    cik = await resolveCIKviaEFTS(ticker);
    if (!cik) {
      console.warn(`[edgar] ${ticker} — CIK not found via map or EFTS, skipping`);
      return [];
    }
  }

  // ── 3. Find most recent NPORT-P accession number ─────────────────────────
  const accNo = await fetchLatestNportAccNo(cik);
  if (!accNo) {
    console.warn(`[edgar] ${ticker} — no NPORT-P filing found for CIK ${cik}`);
    return [];
  }

  // ── 4. Fetch filing index → primary XML URL ──────────────────────────────
  const accNoDashes = stripDashes(accNo);
  const xmlUrl = await fetchPrimaryXmlUrl(cik, accNoDashes);
  if (!xmlUrl) {
    console.warn(`[edgar] ${ticker} — could not find XML in filing index`);
    return [];
  }

  // ── 5. Parse NPORT-P XML ─────────────────────────────────────────────────
  const holdings = await parseNportXml(xmlUrl);
  console.log(`[edgar] ${ticker} — ${holdings.length} holdings parsed`);
  return holdings;
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Fetches holdings for all given fund tickers.
 *
 * - Skips money market funds (FDRXX, ADAXX).
 * - Checks Supabase holdings_cache (15-day TTL) before hitting SEC.
 * - Applies 300ms delay between live SEC fetches.
 * - Calls onProgress after every 3rd ticker.
 *
 * @param {string[]}  fundTickers - Array of fund ticker strings.
 * @param {Function}  onProgress  - Optional callback(completedCount, totalCount).
 * @returns {Promise<Object>}     - { TICKER: [holdingObject, ...] }
 */
export async function fetchAllHoldings(fundTickers, onProgress) {
  const results   = {};
  let completed   = 0;

  // Load CIK map once (module-level cache after first call)
  const cikMap = await loadCIKMap();

  for (let i = 0; i < fundTickers.length; i++) {
    const ticker = fundTickers[i];

    // Skip money market funds
    if (MONEY_MARKET_TICKERS.has(ticker)) {
      results[ticker] = [];
      completed++;
      if (completed % 3 === 0 && onProgress) onProgress(completed, fundTickers.length);
      continue;
    }

    // ── Supabase cache check ──────────────────────────────────────────────
    let cached = null;
    try {
      cached = await getHoldings(ticker);
    } catch (cacheErr) {
      console.warn(`[edgar] ${ticker} cache read error:`, cacheErr.message);
    }

    if (cached && cached.length > 0) {
      results[ticker] = cached;
      completed++;
      if (completed % 3 === 0 && onProgress) onProgress(completed, fundTickers.length);
      continue;
    }

    // ── Live SEC fetch ────────────────────────────────────────────────────
    let holdings = [];
    try {
      holdings = await fetchHoldingsForTicker(ticker, cikMap);
    } catch (err) {
      console.warn(`[edgar] ${ticker} unexpected error:`, err.message);
    }

    // Persist to Supabase regardless of whether holdings is empty
    // (saveHoldings handles empty arrays gracefully — it just clears the rows)
    if (holdings.length > 0) {
      try {
        await saveHoldings(ticker, holdings);
      } catch (saveErr) {
        console.warn(`[edgar] ${ticker} cache save error:`, saveErr.message);
      }
    }

    results[ticker] = holdings;
    completed++;
    if (completed % 3 === 0 && onProgress) onProgress(completed, fundTickers.length);

    // 300ms spacing — SEC rate limit
    if (i < fundTickers.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Final progress tick for any remainder
  if (onProgress && completed > 0 && completed % 3 !== 0) {
    onProgress(completed, fundTickers.length);
  }

  return results;
}
