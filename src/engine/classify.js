// src/engine/classify.js
// Classifies fund holdings into GICS sectors via Claude Haiku.
//
// Pipeline step 4: classifyHoldingSectors()
//   Input:  holdingsMap from edgar.js — { TICKER: { holdings: [...], meta } }
//   Output: same shape, holdings enriched with GICS sector labels
//
// Classification sources (in priority order):
//   1. edgar.js SECTOR_MAP — ~150 common equities (already applied before this step)
//   2. Supabase sector_classifications cache — 15-day TTL, keyed by holding_name
//   3. Claude Haiku — batch classification of remaining unclassified holding names
//
// Cache: sector_classifications table (created in A2 SQL session)
//   holding_name TEXT PRIMARY KEY
//   sector       TEXT NOT NULL
//   confidence   TEXT DEFAULT 'claude'
//   cached_at    TIMESTAMPTZ DEFAULT NOW()
//
// Extensibility: This file is designed to be replaced with a paid API adapter
// (FMP, EODHD, etc.) without changing the interface. The only export is
// classifyHoldingSectors(holdingsMap) → holdingsMap with sectors filled in.
//
// ⚠️  CRITICAL: All Claude API calls must be SEQUENTIAL with 1.2s delays.
//     Never use Promise.all() for Claude calls. This has broken production 5+ times.
// ⚠️  All Supabase calls route through supaFetch() from api.js.
// ⚠️  No localStorage. No direct Supabase calls.

import { callClaude, supaFetch } from '../services/api.js';
import { CLAUDE_MODEL, GICS_SECTORS } from './constants.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE       = 25;    // holding names per Claude call
const CLAUDE_DELAY_MS  = 1200;  // mandatory delay between Claude calls
const CACHE_TTL_DAYS   = 15;    // sector_classifications cache lifetime

// Valid GICS sector names — used to constrain and validate Claude output
const VALID_SECTORS = Object.keys(GICS_SECTORS);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns true if the cached_at timestamp is older than CACHE_TTL_DAYS.
 */
function isStale(isoString) {
  if (!isoString) return true;
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86_400_000;
  return new Date(isoString).getTime() < cutoff;
}

// ---------------------------------------------------------------------------
// Supabase sector_classifications cache
// ---------------------------------------------------------------------------
// cache.js does not have helpers for this table yet (added in A10).
// We use supaFetch directly until then.

/**
 * Reads cached sector classifications for a list of holding names.
 * Returns a Map<holdingName, sector> for all fresh (non-stale) entries.
 */
async function getCachedSectors(holdingNames) {
  const cached = new Map();
  if (!holdingNames || holdingNames.length === 0) return cached;

  // PostgREST IN filter — batch in groups of 50 to avoid URL length limits
  for (let i = 0; i < holdingNames.length; i += 50) {
    const batch = holdingNames.slice(i, i + 50);
    const inList = batch.map(n => `"${n.replace(/"/g, '\\"')}"`).join(',');

    try {
      const rows = await supaFetch(
        `sector_classifications?holding_name=in.(${inList})`
      );

      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!isStale(row.cached_at) && row.sector) {
            cached.set(row.holding_name, row.sector);
          }
        }
      }
    } catch (err) {
      console.warn('[classify] cache read error:', err.message);
      // Non-fatal — we'll classify via Claude instead
    }
  }

  return cached;
}

/**
 * Saves new sector classifications to the cache.
 * classifications: Array of { holding_name, sector }
 */
async function saveCachedSectors(classifications) {
  if (!classifications || classifications.length === 0) return;

  const now = new Date().toISOString();
  const rows = classifications.map(c => ({
    holding_name: c.holding_name,
    sector:       c.sector,
    confidence:   'claude',
    cached_at:    now,
  }));

  // Batch upsert in groups of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    try {
      await supaFetch('sector_classifications?on_conflict=holding_name', {
        method: 'POST',
        body: JSON.stringify(batch),
        headers: {
          'Prefer': 'resolution=merge-duplicates,return=representation',
        },
      });
    } catch (err) {
      console.warn('[classify] cache write error:', err.message);
      // Non-fatal — classifications are still in memory for this run
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Haiku sector classification
// ---------------------------------------------------------------------------

/**
 * Sends a batch of holding names to Claude Haiku for GICS sector classification.
 * Returns a Map<holdingName, sector> for successfully classified holdings.
 *
 * Holdings that don't map to a GICS sector (treasuries, money markets,
 * derivatives, repos, etc.) are returned with sector = null and excluded
 * from the result map.
 */
async function classifyBatch(holdingNames) {
  const result = new Map();
  if (!holdingNames || holdingNames.length === 0) return result;

  const sectorList = VALID_SECTORS.join(', ');

  const prompt = `You are a financial data classifier. For each holding name below, determine which GICS sector it belongs to.

Valid sectors (use EXACTLY these names):
${sectorList}

If a holding does not belong to any GICS sector (e.g. government bonds, treasuries, money market instruments, repurchase agreements, derivatives, index futures, currency forwards, or other non-equity/non-corporate-bond holdings), return null for its sector.

Holdings to classify:
${holdingNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

Respond with ONLY a JSON array of objects, one per holding, in the same order. Each object has two fields:
- "name": the exact holding name as provided
- "sector": one of the valid sector names listed above, or null

Example response format:
[{"name":"APPLE INC","sector":"Technology"},{"name":"US TREASURY NOTE 2.5%","sector":null}]

JSON only. No markdown fences. No explanation.`;

  try {
    const response = await callClaude({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text from Claude response
    const text = (response?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!text) {
      console.warn('[classify] empty Claude response');
      return result;
    }

    // Parse JSON — strip markdown fences if Haiku adds them despite instructions
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      console.warn('[classify] Claude response is not an array');
      return result;
    }

    for (const item of parsed) {
      if (!item || !item.name) continue;

      const sector = item.sector;

      // Validate sector is in our GICS list or is explicitly null
      if (sector === null || sector === 'null') continue; // skip non-GICS holdings
      if (!VALID_SECTORS.includes(sector)) {
        console.warn(`[classify] invalid sector "${sector}" for "${item.name}" — skipping`);
        continue;
      }

      result.set(item.name, sector);
    }
  } catch (err) {
    console.warn('[classify] Claude classification error:', err.message);
    // Non-fatal — unclassified holdings stay sector: null
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Enriches holdings across all funds with GICS sector labels.
 *
 * Pipeline step 4. Sits between edgar.js (step 3) and tiingo.js (step 5).
 *
 * Process:
 *   1. Collect all unique holding names with sector: null across all funds
 *   2. Check sector_classifications cache (15-day TTL)
 *   3. Batch-classify uncached names via Claude Haiku (sequential, 1.2s delay)
 *   4. Save new classifications to cache
 *   5. Apply sectors back to all holdings in-place
 *
 * @param {Object} holdingsMap - edgar.js output: { TICKER: { holdings: [...], meta } }
 * @param {Function} [onProgress] - Optional callback(classified, total) for UI updates
 * @returns {Promise<Object>} - Same holdingsMap shape, holdings enriched with sectors
 */
export async function classifyHoldingSectors(holdingsMap, onProgress) {
  if (!holdingsMap || typeof holdingsMap !== 'object') return holdingsMap ?? {};

  // ── 1. Collect unique unclassified holding names ────────────────────────
  const unclassifiedNames = new Set();

  for (const ticker of Object.keys(holdingsMap)) {
    const entry = holdingsMap[ticker];
    const holdings = entry?.holdings ?? [];

    for (const h of holdings) {
      if (!h.sector && h.holding_name) {
        unclassifiedNames.add(h.holding_name);
      }
    }
  }

  if (unclassifiedNames.size === 0) {
    console.log('[classify] all holdings already have sectors — skipping');
    return holdingsMap;
  }

  console.log(`[classify] ${unclassifiedNames.size} unique holdings need sector classification`);

  // ── 2. Check sector_classifications cache ───────────────────────────────
  const nameList = Array.from(unclassifiedNames);
  const cached = await getCachedSectors(nameList);

  const stillNeeded = nameList.filter(name => !cached.has(name));
  console.log(`[classify] ${cached.size} found in cache, ${stillNeeded.length} need Claude classification`);

  // ── 3. Batch-classify uncached names via Claude Haiku ───────────────────
  const newClassifications = new Map();

  if (stillNeeded.length > 0) {
    const totalBatches = Math.ceil(stillNeeded.length / BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * BATCH_SIZE;
      const batch = stillNeeded.slice(batchStart, batchStart + BATCH_SIZE);

      console.log(`[classify] batch ${b + 1}/${totalBatches}: ${batch.length} holdings`);

      const batchResult = await classifyBatch(batch);

      for (const [name, sector] of batchResult) {
        newClassifications.set(name, sector);
      }

      if (onProgress) {
        const classified = cached.size + newClassifications.size;
        onProgress(classified, nameList.length);
      }

      // Sequential delay between Claude calls (mandatory — plan line 470)
      if (b < totalBatches - 1) {
        await sleep(CLAUDE_DELAY_MS);
      }
    }
  }

  // ── 4. Save new classifications to cache ────────────────────────────────
  if (newClassifications.size > 0) {
    const toSave = Array.from(newClassifications).map(([name, sector]) => ({
      holding_name: name,
      sector,
    }));

    await saveCachedSectors(toSave);
    console.log(`[classify] saved ${toSave.length} new classifications to cache`);
  }

  // ── 5. Apply sectors to all holdings ────────────────────────────────────
  // Merge cached + new into a single lookup
  const sectorLookup = new Map([...cached, ...newClassifications]);

  let applied = 0;
  for (const ticker of Object.keys(holdingsMap)) {
    const entry = holdingsMap[ticker];
    const holdings = entry?.holdings ?? [];

    for (const h of holdings) {
      if (!h.sector && h.holding_name && sectorLookup.has(h.holding_name)) {
        h.sector = sectorLookup.get(h.holding_name);
        applied++;
      }
    }
  }

  console.log(`[classify] applied sectors to ${applied} holdings across all funds`);

  // Final progress tick
  if (onProgress) {
    onProgress(nameList.length, nameList.length);
  }

  return holdingsMap;
}
