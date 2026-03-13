// FundLens v4 — World data fetcher
// Fetches and caches the macro environment: FRED economic series,
// Treasury yield curve, and financial news headlines.
//
// Architecture notes:
// - FRED fetches are SEQUENTIAL (one at a time) — FRED rate limits aggressively.
// - Treasury and news fetches happen after FRED completes.
// - Cache TTL is DEFAULT_WORLD_TTL_MINS (60 min) — checked by caller.
// - Treasury data is stored in its own Supabase column (treasury_data), separate
//   from fred_data, because yield curve values are forward-looking market signals
//   while FRED series are lagging economic measurements. They serve different
//   purposes in mandate.js scoring and should not be mixed.

import { FRED_SERIES, RSS_FEEDS, DEFAULT_WORLD_TTL_MINS } from './constants.js';
import { fetchFredSeries, fetchTreasury, fetchGdelt, fetchRSS } from '../services/api.js';
import { getWorldData, setWorldData } from '../services/cache.js';

// — FRED ——————————————————————————————————————————————————————————————————
// Fetch all 10 series sequentially. FRED rate-limits concurrent requests.
// Each series returns up to 5 observations (sorted desc); we take the first
// whose value is not '.' (missing data marker used during reporting lags).
async function buildFredData() {
  const fredData = {};
  for (const [seriesId, label] of Object.entries(FRED_SERIES)) {
    try {
      const data = await fetchFredSeries(seriesId);
      const obs = data?.observations ?? [];
      const hit = obs.find(o => o.value !== '.');
      if (hit) {
        fredData[seriesId] = {
          value: parseFloat(hit.value),
          date:  hit.date,
          label,
        };
      } else {
        console.warn('world.js: no valid observation for', seriesId);
      }
    } catch (err) {
      console.warn('world.js: FRED fetch failed for', seriesId, err.message);
    }
  }
  return fredData;
}

// — Treasury yield curve ——————————————————————————————————————————————————
// fetchTreasury() returns { date, y1, y2, y5, y10, y30 } directly.
// We compute four spreads that each measure a different part of the curve:
//
//   shortEnd : y2  - y1           Fed policy signal (near-term rate expectations)
//   belly    : y5  - (y2+y10)/2   Curve curvature — is the middle bowed up or down?
//   classic  : y10 - y2           Classic recession predictor (most-watched spread)
//   longEnd  : y30 - y10          Long-term inflation expectations
//
// All four are passed as raw numbers to mandate.js so Claude can reason about
// the actual shape of the curve, not a compressed label or single score.
async function buildTreasuryData() {
  try {
    const t = await fetchTreasury();
    if (!t || !t.y1 || !t.y10) {
      console.warn('world.js: Treasury data missing or incomplete', t);
      return null;
    }
    const round2 = n => Math.round(n * 100) / 100;
    return {
      date: t.date,
      y1:   t.y1,
      y2:   t.y2,
      y5:   t.y5,
      y10:  t.y10,
      y30:  t.y30,
      spreads: {
        shortEnd: round2(t.y2  - t.y1),
        belly:    round2(t.y5  - (t.y2 + t.y10) / 2),
        classic:  round2(t.y10 - t.y2),
        longEnd:  round2(t.y30 - t.y10),
      },
    };
  } catch (err) {
    console.warn('world.js: Treasury fetch failed', err.message);
    return null;
  }
}

// — RSS parsing ———————————————————————————————————————————————————————————
// Parse an RSS XML string into a flat array of headline objects.
// Handles both <item> (RSS 2.0) and <entry> (Atom) elements.
function parseRSS(xmlText, label) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const items = [...doc.querySelectorAll('item, entry')];
    return items.map(item => {
      const get = tag => item.querySelector(tag)?.textContent?.trim() || '';
      const link = item.querySelector('link')?.getAttribute('href')
                || get('link')
                || '';
      return {
        title:     get('title'),
        link,
        published: get('pubDate') || get('published') || get('updated') || '',
        source:    label,
      };
    }).filter(h => h.title);
  } catch (err) {
    console.warn('world.js: RSS parse failed for', label, err.message);
    return [];
  }
}

// — News: RSS + GDELT merge ———————————————————————————————————————————————
// Order of operations:
//   1. Fetch all 4 RSS feeds sequentially — these are higher quality, go first
//   2. Fetch GDELT — broader coverage, appended after RSS
//   3. Deduplicate by first 60 chars of lowercased title
//   4. Slice to 36 headlines
async function buildHeadlines() {
  const headlines = [];
  const seen = new Set();

  const addHeadline = (h) => {
    if (!h.title) return;
    const key = h.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    headlines.push(h);
  };

  // RSS feeds — sequential
  for (const feed of RSS_FEEDS) {
    try {
      const xml = await fetchRSS(feed.url);
      const items = parseRSS(xml, feed.label);
      items.forEach(addHeadline);
    } catch (err) {
      console.warn('world.js: RSS failed for', feed.label, err.message);
    }
  }

  // GDELT — appended after RSS
  try {
    const gdelt = await fetchGdelt({
      query:    'finance economy market',
      mode:     'artlist',
      maxrecords: 25,
      format:   'json',
    });
    const articles = gdelt?.articles ?? [];
    articles.forEach(a => addHeadline({
      title:     a.title,
      link:      a.url,
      published: a.seendate || '',
      source:    'GDELT',
    }));
  } catch (err) {
    console.warn('world.js: GDELT fetch failed', err.message);
  }

  return headlines.slice(0, 36);
}

// — Public entry point ————————————————————————————————————————————————————
// force=true bypasses the TTL check and always fetches fresh data.
// Called by pipeline.js at the start of every run.
export async function fetchWorldData(force = false) {
  // Check cache first
  if (!force) {
    try {
      const cached = await getWorldData();
      if (cached?.fetched_at) {
        const ageMin = (Date.now() - new Date(cached.fetched_at).getTime()) / 60000;
        if (ageMin < DEFAULT_WORLD_TTL_MINS) {
          return {
            fredData:     cached.fred_data     ?? {},
            headlines:    cached.headlines     ?? [],
            treasuryData: cached.treasury_data ?? null,
            fetchedAt:    cached.fetched_at,
            fromCache:    true,
          };
        }
      }
    } catch (err) {
      // Cache miss or Supabase unavailable — fall through to fresh fetch
      console.warn('world.js: cache read failed, fetching fresh', err.message);
    }
  }

  // Fetch fresh data
  const [fredData, treasuryData, headlines] = await Promise.all([
    buildFredData(),
    buildTreasuryData(),
    buildHeadlines(),
  ]);

  // Persist to Supabase
  try {
    await setWorldData(fredData, headlines, treasuryData);
  } catch (err) {
    console.warn('world.js: cache write failed', err.message);
    // Non-fatal — return data even if save fails
  }

  return {
    fredData,
    headlines,
    treasuryData,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
}
