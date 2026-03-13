// FundLens v4 — EDGAR holdings fetcher
// Fetches the latest NPORT-P filing for a fund and returns parsed holdings.
// Three CIK lookup strategies, verbatim from v3.
// MF tickers file is loaded once per session and cached in memory.

import { CLAUDE_MODEL } from './constants.js';

// Module-level cache for the SEC mutual fund tickers file.
// Loaded once on first call, reused for every subsequent fund lookup.
// Prevents 22 identical fetches of the same large file per pipeline run.
let _mfTickersCache = null;

// — CIK lookup strategy 1: SEC company_tickers_mf.json ——————————————————

async function cikFromMfJson(ticker) {
  if (!_mfTickersCache) {
    try {
      const res = await fetch('/api/www4sec/files/company_tickers_mf.json');
      if (!res.ok) {
        _mfTickersCache = {}; // mark as attempted so we don't retry on every fund
        return null;
      }
      const data = await res.json();
      // data is an object keyed by index; each value has { cik_str, ticker, ... }
      _mfTickersCache = {};
      Object.values(data).forEach(row => {
        if (row.ticker) _mfTickersCache[row.ticker.toUpperCase()] = String(row.cik_str);
      });
    } catch (e) {
      console.warn('MF tickers file failed to load:', e.message);
      _mfTickersCache = {};
    }
  }
  return _mfTickersCache[ticker.toUpperCase()] || null;
}

// — CIK lookup strategy 2: EFTS full-text search ————————————————————————

async function cikFromEfts(ticker) {
  const url = '/api/efts/LATEST/search-index?q='
    + encodeURIComponent(ticker) + '&forms=NPORT-P';
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const hit  = data?.hits?.hits?.[0]?._source;
  return hit?.entity_id ? String(hit.entity_id) : null;
}

// — CIK lookup strategy 3: fund name words fallback ————————————————————

async function cikFromName(fundName) {
  if (!fundName) return null;
  // Use first two meaningful words of the fund name
  const words = fundName.split(/\s+/).filter(w => w.length > 2).slice(0, 2).join('+');
  if (!words) return null;
  const url = '/api/efts/LATEST/search-index?q='
    + encodeURIComponent(words) + '&forms=NPORT-P';
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const hit  = data?.hits?.hits?.[0]?._source;
  return hit?.entity_id ? String(hit.entity_id) : null;
}

// — Fetch latest NPORT-P accession for a CIK ————————————————————————————

async function fetchNportByCIK(cik, ticker) {
  const padded = cik.padStart(10, '0');
  const res    = await fetch('/api/edgar/submissions/CIK' + padded + '.json');
  if (!res.ok) throw new Error('EDGAR submissions ' + res.status + ' for ' + ticker);
  const data     = await res.json();
  const filings  = data.filings?.recent;
  if (!filings?.form) return null;

  let latestIdx = -1;
  filings.form.forEach((form, i) => {
    if (form === 'NPORT-P') {
      if (latestIdx === -1 || filings.filingDate[i] > filings.filingDate[latestIdx]) {
        latestIdx = i;
      }
    }
  });
  if (latestIdx === -1) return null;

  return fetchNportByAccession(cik, filings.accessionNumber[latestIdx], ticker);
}

// — Fetch and parse XML from a known accession number ————————————————————

async function fetchNportByAccession(cik, accNo, ticker) {
  const accNoDashes = accNo.replace(/-/g, '');
  const indexUrl    = '/api/www4sec/Archives/edgar/data/'
    + cik + '/' + accNoDashes + '/';

  const idxRes = await fetch(indexUrl);
  if (!idxRes.ok) throw new Error('EDGAR index ' + idxRes.status + ' for ' + ticker);
  const idxHtml = await idxRes.text();

  // Find the primary XML file — prefer filenames containing 'nport' or 'primary',
  // avoid index files.
  const xmlMatches = [...idxHtml.matchAll(/href="([^"]+\.xml)"/gi)]
    .map(m => m[1].split('/').pop())
    .filter(f => !f.toLowerCase().includes('index'));

  let xmlFile = xmlMatches.find(f => /nport|primary/i.test(f)) || xmlMatches[0];
  if (!xmlFile) throw new Error('No XML file found in EDGAR index for ' + ticker);

  const xmlUrl = '/api/www4sec/Archives/edgar/data/'
    + cik + '/' + accNoDashes + '/' + xmlFile;

  const xmlRes = await fetch(xmlUrl);
  if (!xmlRes.ok) throw new Error('EDGAR XML ' + xmlRes.status + ' for ' + ticker);

  const xmlText = await xmlRes.text();
  return parseNportXML(xmlText, ticker);
}

// — Parse NPORT-P XML into holdings array ————————————————————————————————

function parseNportXML(xmlText, ticker) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');
  const nodes  = doc.querySelectorAll('invstOrSec');

  if (!nodes.length) return null;

  const raw = [];
  nodes.forEach(node => {
    const get = tag => node.querySelector(tag)?.textContent?.trim() || '';

    // Ticker lives inside <identifiers><ticker value="..."/>
    const tickerEl    = node.querySelector('identifiers ticker');
    const holdingTicker = tickerEl?.getAttribute('value') || '';

    const pctVal = parseFloat(get('pctVal'));
    if (!pctVal || pctVal <= 0) return;

    raw.push({
      name:     get('name'),
      ticker:   holdingTicker.toUpperCase(),
      cusip:    get('cusip'),
      pctVal:   pctVal,
      valUSD:   parseFloat(get('valUSD'))  || 0,
      shares:   parseFloat(get('shares'))  || 0,
      assetCat: get('assetCat'),
      sector:   '',
    });
  });

  raw.sort((a, b) => b.pctVal - a.pctVal);

  // Normalise only when weights are inflated (e.g. leveraged fund double-counts)
  const rawTotal = raw.reduce((s, h) => s + h.pctVal, 0);
  if (rawTotal > 110) {
    raw.forEach(h => { h.pctVal = +(h.pctVal / rawTotal * 100).toFixed(4); });
  }

  return raw;
}

// — Classify unknown sectors via Claude (batched, concurrent) ————————————
// unknownHoldings: array of { ticker, name }
// Returns: { [ticker]: sector }

export async function classifyUnknownSectors(unknownHoldings) {
  if (!unknownHoldings.length) return {};

  const PAGE_SIZE = 60;
  const pages     = [];
  for (let i = 0; i < unknownHoldings.length; i += PAGE_SIZE) {
    pages.push(unknownHoldings.slice(i, i + PAGE_SIZE));
  }

  const VALID_SECTORS = [
    'Technology', 'Financials', 'Healthcare', 'Consumer Discretionary',
    'Consumer Staples', 'Energy', 'Industrials', 'Materials', 'Utilities',
    'Real Estate', 'Communication Services', 'Cash/Other',
  ];

  const results = await Promise.all(
    pages.map(async page => {
      const list   = page.map(h => (h.ticker || 'UNKNOWN') + '|' + h.name).join('\n');
      const prompt = 'Classify each holding by GICS sector.\n'
        + 'Valid sectors: ' + VALID_SECTORS.join(', ') + '\n'
        + 'Format: respond ONLY with valid JSON: {"classifications":{"TICKER":"SECTOR"}}\n'
        + 'Use "Cash/Other" for bonds, cash, derivatives, or unknowns.\n'
        + 'Holdings:\n' + list;

      try {
        const res = await fetch('/api/claude', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            model:      CLAUDE_MODEL,
            max_tokens: 1000,
            messages:   [{ role: 'user', content: prompt }],
          }),
        });
        if (!res.ok) return {};
        const data  = await res.json();
        const text  = (data.content || []).map(b => b.text || '').join('').trim();
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        return parsed.classifications || {};
      } catch (_) {
        return {};
      }
    })
  );

  return Object.assign({}, ...results);
}

// — Public entry point ————————————————————————————————————————————————————

export async function fetchEdgarHoldings(ticker, fundName) {
  let cik = null;

  // Strategy 1: MF ticker JSON (fastest, most reliable)
  try { cik = await cikFromMfJson(ticker); } catch (_) {}

  // Strategy 2: EFTS full-text search
  if (!cik) {
    try { cik = await cikFromEfts(ticker); } catch (_) {}
  }

  // Strategy 3: Fund name words
  if (!cik) {
    try { cik = await cikFromName(fundName); } catch (_) {}
  }

  if (!cik) throw new Error('Could not resolve CIK for ' + ticker);

  return fetchNportByCIK(cik, ticker);
}
