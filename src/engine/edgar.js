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
import { fetchEdgar, fetchEfts, fetchSEC } from '../services/api.js';

const SECTOR_BATCH_SIZE  = 20;  // Max tickers sent to Claude per sector request
const MIN_EQUITY_WEIGHT  = 0.1; // % — skip sector lookup for tiny equity positions

// ── CIK lookup ────────────────────────────────────────────────────────────────
// Resolve a mutual fund ticker to its SEC CIK number.
// Primary: EFTS full-text search (efts.sec.gov).
// Fallback: www.sec.gov browse-edgar Atom feed (stable, decades-old endpoint).
// EFTS has been returning 403 from Railway IPs since ~March 2026.
async function getCik(ticker) {
  // ── Attempt 1: EFTS full-text search ──────────────────────────────────────
  try {
    const data = await fetchEfts('/hits.json', {
      q:        `"${ticker}"`,
      dateRange: 'custom',
      startdt:  '2020-01-01',
      forms:    'NPORT-P',
    });

    const hits = data?.hits?.hits ?? [];
    for (const hit of hits) {
      const filingCik = hit._source?.period_of_report
        ? hit._id?.split('-')[0]?.replace(/^0+/, '')
        : null;
      if (filingCik) return filingCik;
    }
  } catch (err) {
    console.warn(`[edgar] EFTS lookup failed for ${ticker} (${err.message}), trying browse-edgar fallback`);
  }

  // ── Attempt 2: www.sec.gov browse-edgar Atom feed ─────────────────────────
  // Put the ticker in the CIK field -- SEC resolves ticker to CIK automatically.
  // Returns Atom XML with <cik> tag containing the numeric CIK.
  try {
    const xml = await fetchSEC(
      `/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=NPORT-P&dateb=&owner=include&count=1&search_text=&output=atom`
    );

    // Extract CIK from <cik> element in the Atom response
    const cikMatch = xml.match(/<cik[^>]*>0*(\d+)<\/cik>/i);
    if (cikMatch) return cikMatch[1];

    // Fallback: CIK sometimes appears in link URLs as CIK=0001234567
    const linkMatch = xml.match(/CIK=0*(\d+)/);
    if (linkMatch) return linkMatch[1];
  } catch (err) {
    console.warn(`[edgar] browse-edgar fallback also failed for ${ticker}:`, err.message);
  }

  console.warn(`[edgar] Could not resolve CIK for ${ticker} via any method`);
  return null;
}

// ── Latest NPORT-P accession ──────────────────────────────────────────────────
// Given a CIK, find the most recent NPORT-P filing accession number.
async function getLatestNportAccession(cik) {
  try {
    const data = await fetchEdgar(`/submissions/CIK${cik.padStart(10, '0')}.json`);
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

// ── Parse holdings from NPORT-P JSON ─────────────────────────────────────────
// EDGAR serves NPORT-P as structured JSON via the XBRL viewer endpoint.
// We extract invstOrSecs (investments or securities) array.
function parseHoldings(nportData, totalNav) {
  try {
    const investments = nportData?.formData?.invstOrSecs ?? [];
    const holdings = [];

    for (const inv of investments) {
      const name     = inv?.name ?? '';
      const ticker   = inv?.ticker ?? inv?.isin ?? inv?.cusip ?? '';
      const assetCat = (inv?.assetCat ?? 'OTH').toUpperCase();
      const value    = parseFloat(inv?.valUSD ?? inv?.fairValUSD ?? 0);
      const weight   = totalNav > 0 ? (value / totalNav) * 100 : 0;

      if (!name && !ticker) continue;
      if (value <= 0) continue;

      holdings.push({
        ticker:   ticker.trim(),
        name:     name.trim(),
        assetCat,
        weight:   Math.round(weight * 10000) / 10000,
        value:    Math.round(value * 100) / 100,
        sector:   null,
        industry: null,
      });
    }

    // Sort by weight descending
    holdings.sort((a, b) => b.weight - a.weight);
    return holdings;
  } catch (err) {
    console.warn('[edgar] Holdings parse failed:', err.message);
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

  // Fetch NPORT-P filing data
  let holdings = [];
  try {
    const accessionClean = accession.replace(/-/g, '');
    const nportData = await fetchEdgar(
      `/archives/${cik.padStart(10, '0')}/${accessionClean}/xbrl_data.json`
    );

    // Extract total NAV for weight calculation
    const totalNav = parseFloat(
      nportData?.formData?.genInfo?.totalAssets ??
      nportData?.formData?.fundInfo?.totAssets ?? 0
    );

    holdings = parseHoldings(nportData, totalNav);
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
