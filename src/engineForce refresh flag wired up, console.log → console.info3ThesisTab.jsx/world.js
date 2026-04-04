// src/engine/world.js
// Fetches all "world data" — the macro intelligence that feeds thesis and
// sector scoring. Reads source_registry to know which sources are enabled
// for the current user, then fetches only those.
//
// Export: fetchWorldData(userId, onProgress)
//   onProgress(detail) — string status update callback, called throughout
//
// Return shape (matches thesis.js buildPrompt expectations exactly):
//   {
//     fred,           // { SERIES_ID: { label, value, date, prev } }
//     treasury,       // { y2, y10, y30, date } | null
//     gold,           // { price: string, date: string } | null
//     headlines,      // { title: string }[], deduplicated, ≤ 36
//     fetchedAt,      // ISO timestamp
//     dataQuality: {
//       fredSeriesCount, fredSeriesTotal,
//       headlineCount, gdeltHeadlineCount,
//       fredOk, gdeltOk
//     }
//   }
//
// Also persists to Supabase via saveWorldData().

import { apiFetch, fetchGdelt, fetchRSS } from '../services/api.js';
import { getEnabledSources, getWorldData, saveWorldData } from '../services/cache.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

// World data cache TTL — serves cached macro data for subsequent pipeline runs
// within this window, preventing redundant GDELT/FRED/Treasury calls.
const WORLD_TTL_MINS = 30;

function oneYearAgoISO() {
  return new Date(Date.now() - 365 * MS_PER_DAY).toISOString().slice(0, 10);
}

// Resolves the source type field regardless of whether getEnabledSources
// returns it as `type` or `source_type` (Supabase column name).
function sourceType(s) {
  return s.source_type ?? s.type ?? '';
}

// ---------------------------------------------------------------------------
// FRED helpers
// ---------------------------------------------------------------------------

// These series are raw index levels in FRED, not rates or percentages.
// Requesting units=pc1 converts them to year-over-year % change so Claude
// receives "2.8" (inflation rate) instead of "327" (CPI index level).
const FRED_PC1_SERIES = new Set([
  'CPIAUCSL',   // Consumer Price Index level → YoY %
  'CPILFESL',   // Core CPI level → YoY %
  'INDPRO',     // Industrial Production index → YoY %
  'PCEPI',      // PCE Price Index level → YoY %
  'PCEPILFE',   // Core PCE level → YoY %
]);

async function fetchFredObservations(seriesId) {
  const params = {
    series_id:         seriesId,
    sort_order:        'desc',
    limit:             '5',
    observation_start: oneYearAgoISO(),
  };
  // Convert index-level series to year-over-year % change automatically.
  if (FRED_PC1_SERIES.has(seriesId)) {
    params.units = 'pc1';
  }
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/api/fred/series/observations?${qs}`);
}

function extractLatestObservation(data) {
  // FRED API returns { observations: [{ date, value }, ...] }
  const obs   = data?.observations ?? [];
  const valid = obs.filter(o => o.value !== '.' && o.value != null && o.value !== '');
  if (valid.length === 0) return { value: null, date: null, prev: null };
  return {
    value: parseFloat(valid[0].value),
    date:  valid[0].date,
    prev:  valid[1] ? parseFloat(valid[1].value) : null,
  };
}

// ---------------------------------------------------------------------------
// Treasury helper
// ---------------------------------------------------------------------------

async function fetchTreasuryData() {
  const data = await apiFetch('/api/treasury');
  // Expected response: { updated, rows: [{...}, ...] }
  // Take first (newest) row; field names may vary by proxy implementation.
  const row = Array.isArray(data?.rows) && data.rows.length > 0
    ? data.rows[0]
    : null;
  if (!row) return null;

  // Accept multiple possible field name conventions from the proxy.
  const pick = (...keys) => {
    for (const k of keys) {
      const v = parseFloat(row[k]);
      if (!isNaN(v) && v !== 0) return v;
    }
    return null;
  };

  // Normalise to the field names thesis.js buildPrompt() expects:
  // y1, y2, y5, y10, y30, date
  return {
    y2:   pick('2 Yr',  't2y',  'y2',  'BC_2YEAR'),
    y10:  pick('10 Yr', 't10y', 'y10', 'BC_10YEAR'),
    y30:  pick('30 Yr', 't30y', 'y30', 'BC_30YEAR'),
    date: data.updated ?? new Date().toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Gold helper (Twelvedata via Railway proxy)
// ---------------------------------------------------------------------------

async function fetchGoldPrice() {
  try {
    const gd    = await apiFetch('/api/twelvedata/quote?symbol=XAU%2FUSD');
    const price = parseFloat(gd?.close ?? gd?.price ?? '');
    return isNaN(price) || price <= 0 ? null : price.toFixed(2);
  } catch (err) {
    console.warn('[world.js] Gold fetch failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// GDELT adaptive query builder
// Reads key FRED signals and picks the two highest-priority macro themes.
// Two static queries (trade/tariffs and geopolitical baseline) are always
// appended as queries 3 and 4.
// ---------------------------------------------------------------------------

function buildGdeltQueries(fred, goldPrice) {
  // Extract numeric values — keys are whatever series_id the source_registry
  // uses, so we try a handful of known aliases.
  const get = (...ids) => {
    for (const id of ids) {
      const v = fred[id]?.value;
      if (v != null && !isNaN(v)) return v;
    }
    return null;
  };

  const dff   = get('DFF',  'FEDFUNDS');              // Fed Funds Rate
  const dxy   = get('DXY',  'DTWEXBGS');              // USD index
  const hy    = get('BAMLH0A0HYM2', 'HY', 'HYOAS');  // HY OAS spread
  const t10y  = get('DGS10', 'T10Y', 'BC_10YEAR');   // 10Y yield
  const t2y   = get('DGS2',  'T2Y',  'BC_2YEAR');    // 2Y yield
  const bei   = get('T10YIE', 'BREAKEVEN', 'T10YIEM'); // 10Y breakeven inflation
  const oil   = get('DCOILWTICO', 'OIL', 'WTI');      // WTI crude
  const umcsi = get('UMCSENT', 'SENTIMENT', 'UMich'); // Consumer sentiment
  const gold  = goldPrice ? parseFloat(goldPrice) : null;
  const curve = t10y != null && t2y != null ? t10y - t2y : null;

  const signals = [];

  if (hy != null && hy > 5)
    signals.push({ p: 10, q: 'high yield credit spreads bond market stress distress' });
  if (curve != null && curve < -0.2)
    signals.push({ p: 9,  q: 'yield curve inverted recession risk federal reserve policy' });
  if (gold != null && gold > 3000)
    signals.push({ p: 9,  q: 'gold safe haven rally inflation hedge central bank buying' });
  if (dxy != null && dxy < 100)
    signals.push({ p: 8,  q: 'weak dollar international rotation emerging markets equities' });
  if (dxy != null && dxy > 108)
    signals.push({ p: 8,  q: 'strong dollar emerging market pressure capital outflows' });
  if (oil != null && oil > 85)
    signals.push({ p: 7,  q: 'oil price surge energy sector geopolitics supply disruption' });
  if (oil != null && oil < 55)
    signals.push({ p: 7,  q: 'oil demand collapse economic slowdown energy sector earnings' });
  if (bei != null && bei > 2.7)
    signals.push({ p: 7,  q: 'inflation breakeven treasury rates commodities real assets' });
  if (umcsi != null && umcsi < 65)
    signals.push({ p: 6,  q: 'consumer confidence weak spending retail downturn recession' });
  if (dff != null && dff > 4.5)
    signals.push({ p: 6,  q: 'high interest rates fed policy credit tightening refinancing' });
  if (dff != null && dff < 3.5)
    signals.push({ p: 6,  q: 'federal reserve rate cuts easing cycle equity rally bonds' });
  if (hy != null && hy > 3.5 && hy <= 5)
    signals.push({ p: 5,  q: 'credit spread widening corporate bonds risk appetite decline' });

  signals.sort((a, b) => b.p - a.p);
  const top2 = signals.slice(0, 2).map(s => s.q);

  const fallbacks = [
    'equity market volatility stock earnings guidance outlook',
    'federal reserve monetary policy inflation economic outlook',
  ];
  while (top2.length < 2) {
    top2.push(fallbacks[top2.length]);
  }

  return [
    ...top2,
    'trade tariffs earnings guidance corporate profits supply chain',
    'geopolitical risk military conflict global security instability',
  ];
}

// ---------------------------------------------------------------------------
// RSS parser
// ---------------------------------------------------------------------------

function parseRSSItems(xml, sourceLabel, limit = 12) {
  try {
    const doc   = new DOMParser().parseFromString(xml, 'text/xml');
    const items = Array.from(doc.querySelectorAll('item, entry'));
    return items
      .slice(0, limit)
      .map(item => {
        const raw = item.querySelector('title')?.textContent?.trim() ?? '';
        return raw ? `[${sourceLabel}] ${raw}` : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplication — compare first 60 characters lowercase
// ---------------------------------------------------------------------------

function deduplicateHeadlines(headlines) {
  const seen = new Set();
  return headlines.filter(h => {
    const key = h.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function fetchWorldData(userId, onProgress = () => {}) {
  // ── Force refresh — SettingsTab sets this flag to bypass cache on next run ──
  let forceRefresh = false;
  try {
    if (sessionStorage.getItem('fl_force_world_refresh') === '1') {
      forceRefresh = true;
      sessionStorage.removeItem('fl_force_world_refresh');
      console.info('[world.js] Force refresh requested — skipping cache.');
    }
  } catch { /* sessionStorage unavailable — proceed normally */ }

  // ── Cache check — serve recent world data without hitting external APIs ──
  if (!forceRefresh) try {
    const cached = await getWorldData();
    if (cached?.cached_at) {
      const ageMin = (Date.now() - new Date(cached.cached_at).getTime()) / 60000;
      if (ageMin < WORLD_TTL_MINS) {
        onProgress('World data loaded from cache.');

        // Headlines were saved as plain strings — wrap to { title } for thesis.js
        const cachedHeadlines = Array.isArray(cached.headlines)
          ? cached.headlines.map(h => typeof h === 'string' ? { title: h } : h)
          : [];

        // Gold is always fetched fresh (single fast call, not cached in DB)
        const goldRaw  = await fetchGoldPrice();
        const todayISO = new Date().toISOString().slice(0, 10);
        const gold     = goldRaw ? { price: goldRaw, date: todayISO } : null;

        const fredKeys = Object.keys(cached.fred_data ?? {}).filter(k => !k.startsWith('_'));

        return {
          fred:      cached.fred_data      ?? {},
          treasury:  cached.treasury_data  ?? null,
          gold,
          headlines: cachedHeadlines,
          fetchedAt: cached.cached_at,
          dataQuality: {
            fredSeriesCount:    fredKeys.length,
            fredSeriesTotal:    fredKeys.length,
            headlineCount:      cachedHeadlines.length,
            gdeltHeadlineCount: 0,  // indeterminate from cache
            fredOk:             fredKeys.length >= 5,
            gdeltOk:            cachedHeadlines.length > 0,
          },
        };
      }
    }
  } catch (err) {
    console.warn('[world.js] Cache check failed, proceeding with fresh fetch:', err.message);
  }

  onProgress('Loading source configuration…');

  // 1. Get every source merged with user overrides (enabled flag resolved).
  const sources = await getEnabledSources(userId);

  // 2. Partition by type — only enabled rows.
  //    Accept both `source_type` (Supabase column name) and `type` (alias)
  //    so this works regardless of how getEnabledSources maps the field.
  const fredSources     = sources.filter(s => sourceType(s) === 'fred'     && s.enabled);
  const treasurySources = sources.filter(s => sourceType(s) === 'treasury' && s.enabled);
  const gdeltSources    = sources.filter(s => sourceType(s) === 'gdelt'    && s.enabled);
  const rssSources      = sources.filter(s => sourceType(s) === 'rss'      && s.enabled);

  // -------------------------------------------------------------------------
  // 3. FRED — sequential, one request at a time.
  //    The Railway FRED proxy rate-limits concurrent requests.
  // -------------------------------------------------------------------------
  const fred          = {};
  let fredSeriesCount = 0;
  const fredSeriesTotal = fredSources.length;

  for (const source of fredSources) {
    // source.config may carry series_id; fall back to source.id.
    const seriesId = source.config?.series_id ?? source.series_id ?? source.id;
    const label    = source.label ?? source.name ?? seriesId;
    try {
      onProgress(`Fetching FRED: ${label}…`);
      const raw = await fetchFredObservations(seriesId);
      const { value, date, prev } = extractLatestObservation(raw);
      if (value !== null) {
        fred[seriesId] = { label, value, date, prev };
        fredSeriesCount++;
      }
    } catch (err) {
      console.warn(`[world.js] FRED ${seriesId} failed:`, err.message);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Treasury yields — normalised to thesis.js field names (y2, y10, y30)
  // -------------------------------------------------------------------------
  let treasury = null;
  if (treasurySources.length > 0) {
    try {
      onProgress('Fetching Treasury yield curve…');
      treasury = await fetchTreasuryData();
    } catch (err) {
      console.warn('[world.js] Treasury fetch failed:', err.message);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Gold price — always fetched regardless of source_registry.
  //    Returned as gold: { price, date } to match thesis.js buildPrompt().
  // -------------------------------------------------------------------------
  onProgress('Fetching gold price…');
  const goldRaw  = await fetchGoldPrice();
  const todayISO = new Date().toISOString().slice(0, 10);
  const gold     = goldRaw
    ? { price: goldRaw, date: todayISO }
    : null;

  // Also store in fred map so buildGdeltQueries can read it for signal detection.
  if (goldRaw) {
    fred._goldUSD = {
      label: 'Gold (XAU/USD)',
      value: parseFloat(goldRaw),
      date:  todayISO,
      prev:  null,
    };
  }

  // -------------------------------------------------------------------------
  // 6. GDELT — 4 adaptive queries built from FRED signals.
  //    Fetched sequentially to respect proxy rate limits.
  // -------------------------------------------------------------------------
  const gdeltRawTitles = [];
  if (gdeltSources.length > 0) {
    const queries = buildGdeltQueries(fred, goldRaw);
    for (let i = 0; i < queries.length; i++) {
      try {
        onProgress(`Fetching news signal ${i + 1} of ${queries.length}…`);
        const result = await fetchGdelt({
          query:      queries[i],
          mode:       'ArtList',
          maxrecords: 8,
          format:     'json',
        });
        // fetchGdelt wraps response — articles may be in .articles or .data
        const articles = result?.articles ?? result?.data ?? [];
        for (const article of articles) {
          const title = article.title ?? article.url ?? null;
          if (title) gdeltRawTitles.push(title);
        }
      } catch (err) {
        console.warn(`[world.js] GDELT query ${i + 1} failed:`, err.message);
      }
    }
  }

  // ── GDELT stale-on-fail: if all queries returned nothing, supplement
  //    with cached headlines from the last successful run. Dedup in step 8
  //    will handle any overlap with fresh RSS titles.
  if (gdeltRawTitles.length === 0) {
    try {
      const cached = await getWorldData();
      if (cached?.headlines?.length > 0) {
        for (const h of cached.headlines) {
          if (typeof h === 'string' && h.length > 0) gdeltRawTitles.push(h);
        }
        console.info(`[world.js] GDELT failed — using ${gdeltRawTitles.length} cached headlines as fallback`);
      }
    } catch { /* cache read failed — proceed without fallback */ }
  }

  // -------------------------------------------------------------------------
  // 7. RSS feeds — parallel (each feed is independent).
  //    Uses Promise.allSettled so one failed feed doesn't abort the rest.
  // -------------------------------------------------------------------------
  const rssRawTitles = [];
  if (rssSources.length > 0) {
    onProgress('Fetching RSS news feeds…');
    const results = await Promise.allSettled(
      rssSources.map(async source => {
        const url   = source.config?.url ?? source.url;
        const label = source.label ?? source.name ?? 'Feed';
        if (!url) return [];
        const xml = await fetchRSS(url);
        return parseRSSItems(xml, label);
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') rssRawTitles.push(...r.value);
    }
  }

  // -------------------------------------------------------------------------
  // 8. Merge headlines: RSS first (more current), then GDELT.
  //    Deduplicate on first 60 chars. Hard cap at 36.
  //    Wrap as { title } objects — this is what thesis.js buildPrompt expects.
  // -------------------------------------------------------------------------
  const rawStrings   = deduplicateHeadlines([...rssRawTitles, ...gdeltRawTitles]).slice(0, 36);
  const headlines    = rawStrings.map(title => ({ title }));

  // -------------------------------------------------------------------------
  // 9. Persist to Supabase cache (row id=1, overwritten each run).
  //    Pass the original fred map and plain-string headlines to saveWorldData.
  // -------------------------------------------------------------------------
  try {
    onProgress('Saving world data to cache…');
    await saveWorldData(fred, rawStrings, treasury);
  } catch (err) {
    console.warn('[world.js] saveWorldData failed:', err.message);
  }

  onProgress('World data ready.');

  // -------------------------------------------------------------------------
  // 10. Return — field names match thesis.js buildPrompt() exactly:
  //     fred, treasury (y2/y10/y30/date), gold ({ price, date }), headlines ({ title })
  // -------------------------------------------------------------------------
  return {
    fred,
    treasury,
    gold,
    headlines,
    fetchedAt: new Date().toISOString(),
    dataQuality: {
      fredSeriesCount,
      fredSeriesTotal,
      headlineCount:      headlines.length,
      gdeltHeadlineCount: gdeltRawTitles.length,
      fredOk:             fredSeriesCount >= 5,
      gdeltOk:            gdeltRawTitles.length > 0,
    },
  };
}
