// =============================================================================
// FundLens v5 — src/engine/thesis.js
// Claude thesis generation + GICS sector scoring.
//
// Single Claude call produces:
//   - 350-word investment thesis narrative
//   - 11 GICS sector scores (1–10 with one-sentence reasons)
//   - Dominant theme label (2–4 words)
//   - Macro stance: risk-on | risk-off | mixed
//   - Quarter outlook: bullish | bearish | neutral
//   - Risk factors (3 items)
//   - Catalysts (3 items)
//
// Retry policy:
//   - Up to 3 main attempts. Delay: attempt × 12s between retries.
//   - 429 responses: flat 15s wait, then retry.
//   - JSON parse failure: retry.
//   - Validation gate: sectorScores must have ≥ 5 keys.
//   - If all 3 main attempts fail: one minimal fallback prompt (sector scores only).
//   - If fallback also fails: return null.
//
// Rules:
//   - No localStorage.
//   - No web_search tool in Claude calls.
//   - All Claude calls route through callClaude() → /api/claude.
// =============================================================================

import { CLAUDE_MODEL, GICS_SECTORS } from './constants.js';
import { callClaude }                  from '../services/api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS    = 3;
const RETRY_BASE_MS   = 12_000;   // attempt × 12s
const RATE_LIMIT_MS   = 15_000;   // flat 15s on 429
const MAX_HEADLINES   = 24;
const MIN_SECTORS     = 5;

// FRED series human-readable labels used in the prompt.
const FRED_LABELS = {
  UNRATE:   'Unemployment Rate (%)',
  CPIAUCSL: 'CPI YoY Inflation (%)',
  FEDFUNDS: 'Fed Funds Rate (%)',
  GDP:      'GDP Growth (annualised %)',
  PCEPI:    'PCE Inflation (%)',
  T10YIE:   '10-Year Breakeven Inflation (%)',
  UMCSENT:  'U. of Michigan Consumer Sentiment',
  INDPRO:   'Industrial Production Index',
  PAYEMS:   'Nonfarm Payrolls (thousands)',
  HOUST:    'Housing Starts (thousands)',
  RETAILSMNSA: 'Retail Sales (millions)',
  M2SL:     'M2 Money Supply (billions)',
};

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------
// Formats worldData into the full prompt sent to Claude.

function buildPrompt(worldData) {
  const today = new Date().toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  });

  const lines = [];

  lines.push(`Today's date: ${today}`);
  lines.push('');

  // ── FRED economic indicators ──────────────────────────────────────────────
  lines.push('=== ECONOMIC INDICATORS (FRED) ===');
  const fred = worldData?.fred ?? {};
  if (Object.keys(fred).length === 0) {
    lines.push('(no FRED data available)');
  } else {
    for (const [seriesId, obs] of Object.entries(fred)) {
      const label = FRED_LABELS[seriesId] ?? seriesId;
      const value = obs?.value  != null ? obs.value  : 'N/A';
      const date  = obs?.date   != null ? obs.date   : 'N/A';
      lines.push(`  ${label}: ${value} (${date})`);
    }
  }
  lines.push('');

  // ── Treasury yield curve ──────────────────────────────────────────────────
  lines.push('=== TREASURY YIELD CURVE ===');
  const treasury = worldData?.treasury ?? {};
  if (Object.keys(treasury).length === 0) {
    lines.push('(no treasury data available)');
  } else {
    const ycDate = treasury.date ?? 'N/A';
    lines.push(`  Date: ${ycDate}`);
    if (treasury.y1  != null) lines.push(`  1-Year:  ${treasury.y1}%`);
    if (treasury.y2  != null) lines.push(`  2-Year:  ${treasury.y2}%`);
    if (treasury.y5  != null) lines.push(`  5-Year:  ${treasury.y5}%`);
    if (treasury.y10 != null) lines.push(`  10-Year: ${treasury.y10}%`);
    if (treasury.y30 != null) lines.push(`  30-Year: ${treasury.y30}%`);

    // Derived spreads if enough data is present
    if (treasury.y10 != null && treasury.y2 != null) {
      const spread_10_2 = (treasury.y10 - treasury.y2).toFixed(2);
      lines.push(`  10Y–2Y Spread: ${spread_10_2}% (${Number(spread_10_2) >= 0 ? 'normal' : 'inverted'})`);
    }
    if (treasury.y10 != null && treasury.y1 != null) {
      const spread_10_1 = (treasury.y10 - treasury.y1).toFixed(2);
      lines.push(`  10Y–1Y Spread: ${spread_10_1}%`);
    }
  }
  lines.push('');

  // ── Gold price ────────────────────────────────────────────────────────────
  lines.push('=== GOLD & COMMODITIES ===');
  const gold = worldData?.gold ?? {};
  if (gold.price != null) {
    const goldDate = gold.date ?? 'recent';
    lines.push(`  Gold (XAU/USD): $${gold.price} (${goldDate})`);
  } else {
    lines.push('(no gold data available)');
  }
  lines.push('');

  // ── Sector ETF momentum ───────────────────────────────────────────────────
  lines.push('=== SECTOR ETF MOMENTUM (63-day price trend) ===');
  const sectorMomentum = worldData?.sectorMomentum ?? {};
  const sectorNames    = Object.keys(GICS_SECTORS);
  let hasMomentum      = false;

  for (const sector of sectorNames) {
    const etf  = GICS_SECTORS[sector].etf;
    const data = sectorMomentum[sector] ?? sectorMomentum[etf] ?? null;
    if (data != null) {
      const pct  = data.momentum != null ? (data.momentum * 100).toFixed(2) : 'N/A';
      const sign = pct !== 'N/A' && Number(pct) >= 0 ? '+' : '';
      lines.push(`  ${sector} (${etf}): ${sign}${pct}%`);
      hasMomentum = true;
    }
  }
  if (!hasMomentum) {
    lines.push('(no sector ETF momentum data available)');
  }
  lines.push('');

  // ── News headlines ────────────────────────────────────────────────────────
  lines.push('=== FINANCIAL NEWS HEADLINES (top 24) ===');
  const rawHeadlines = worldData?.headlines ?? [];
  const headlines    = rawHeadlines.slice(0, MAX_HEADLINES);

  if (headlines.length === 0) {
    lines.push('(no headlines available)');
  } else {
    headlines.forEach((h, i) => {
      const title = h.title ?? h.headline ?? '(no title)';
      const date  = h.seendate ?? h.date ?? '';
      lines.push(`  ${i + 1}. ${title}${date ? ` [${date}]` : ''}`);
    });
  }
  lines.push('');

  // ── Scoring instructions ──────────────────────────────────────────────────
  lines.push('=== SECTOR SCORING INSTRUCTIONS ===');
  lines.push('Score each GICS sector from 1 to 10:');
  lines.push('  10 = sector directly captures the dominant macro theme');
  lines.push('  8–9 = strong tailwind from current conditions');
  lines.push('  6–7 = moderate benefit');
  lines.push('  4–5 = neutral / no clear catalyst');
  lines.push('  2–3 = facing meaningful headwinds');
  lines.push('  1   = severe headwinds, avoid');
  lines.push('');
  lines.push('RANGE ANCHORING (mandatory):');
  lines.push('  Use the FULL 1–10 range. A score of 5 is truly neutral.');
  lines.push('  At least 2 sectors MUST score 7 or higher.');
  lines.push('  At least 2 sectors MUST score 4 or lower.');
  lines.push('  If all sectors cluster between 4–7, your analysis lacks conviction.');
  lines.push('  Differentiate clearly: the spread between your best and worst sector');
  lines.push('  should be at least 4 points.');
  lines.push('');

  // ── Sectors to score ──────────────────────────────────────────────────────
  lines.push('=== GICS SECTORS TO SCORE ===');
  sectorNames.forEach(s => lines.push(`  - ${s}`));
  lines.push('');

  // ── Output format ─────────────────────────────────────────────────────────
  lines.push('=== REQUIRED OUTPUT FORMAT ===');
  lines.push('Respond with ONLY valid JSON. No markdown, no backticks, no preamble.');
  lines.push('Exact structure required:');
  lines.push(JSON.stringify({
    thesis:        '350-word investment thesis narrative here',
    sectorScores:  {
      Technology: { score: 7, reason: 'one-sentence explanation' },
      '...':      { score: 5, reason: '...' },
    },
    dominantTheme:  '2–4 word label e.g. "Rate Cut Anticipation"',
    macroStance:    'risk-on | risk-off | mixed',
    quarterOutlook: 'bullish | bearish | neutral',
    riskFactors:    ['risk 1', 'risk 2', 'risk 3'],
    catalysts:      ['catalyst 1', 'catalyst 2', 'catalyst 3'],
  }, null, 2));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildFallbackPrompt
// ---------------------------------------------------------------------------
// Minimal prompt used only if all 3 main attempts fail.
// Requests sector scores only — no data context.

function buildFallbackPrompt() {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const sectorNames = Object.keys(GICS_SECTORS);

  return [
    `Today's date: ${today}`,
    '',
    'You are a quantitative portfolio strategist.',
    'Based on your general knowledge of current macro conditions,',
    'score each of the following GICS sectors from 1–10.',
    '',
    'RANGE ANCHORING (mandatory):',
    '  Use the full 1–10 range.',
    '  At least 2 sectors must score 7 or higher.',
    '  At least 2 sectors must score 4 or lower.',
    '',
    'Sectors to score:',
    ...sectorNames.map(s => `  - ${s}`),
    '',
    'Respond with ONLY valid JSON. No markdown, no backticks, no preamble.',
    'Exact structure:',
    JSON.stringify({
      thesis:        'Minimal fallback: insufficient macro data for full analysis.',
      sectorScores:  Object.fromEntries(
        sectorNames.map(s => [s, { score: 5, reason: 'placeholder' }])
      ),
      dominantTheme:  'Data Unavailable',
      macroStance:    'mixed',
      quarterOutlook: 'neutral',
      riskFactors:    ['Data pipeline failure', 'Incomplete macro context', 'Scoring based on priors only'],
      catalysts:      ['Economic data restoration', 'Pipeline reconnection', 'Manual override'],
    }, null, 2),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// callWithRetry
// ---------------------------------------------------------------------------
// Calls Claude up to MAX_ATTEMPTS times.
// Returns parsed JSON on success, or null on total failure.

async function callWithRetry(prompt) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await callClaude({
        model:      CLAUDE_MODEL,
        max_tokens: 3000,
        system:     'You are a quantitative portfolio strategist. You write with conviction and precision. Your analysis is data-driven and actionable.',
        messages:   [{ role: 'user', content: prompt }],
      });

      // Extract text content from the response.
      const content = response?.content ?? [];
      const textBlock = content.find(b => b.type === 'text');
      const raw = textBlock?.text ?? '';

      if (!raw.trim()) {
        console.warn(`[thesis] Attempt ${attempt}: empty response, retrying…`);
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * RETRY_BASE_MS);
        continue;
      }

      // Strip accidental markdown fences before parsing.
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        console.warn(`[thesis] Attempt ${attempt}: JSON parse failed, retrying…`);
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * RETRY_BASE_MS);
        continue;
      }

      // Validate minimum sector coverage.
      const sectorKeys = Object.keys(parsed?.sectorScores ?? {});
      if (sectorKeys.length < MIN_SECTORS) {
        console.warn(
          `[thesis] Attempt ${attempt}: only ${sectorKeys.length} sectors returned (need ≥${MIN_SECTORS}), retrying…`
        );
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * RETRY_BASE_MS);
        continue;
      }

      // Success.
      console.info(`[thesis] Thesis generated on attempt ${attempt}.`);
      return parsed;

    } catch (err) {
      const is429 = err?.message?.includes('429') || String(err).includes('429');

      if (is429) {
        console.warn(`[thesis] Attempt ${attempt}: rate-limited (429), waiting ${RATE_LIMIT_MS / 1000}s…`);
        await sleep(RATE_LIMIT_MS);
      } else {
        console.error(`[thesis] Attempt ${attempt}: unexpected error —`, err);
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * RETRY_BASE_MS);
      }
    }
  }

  // All main attempts exhausted.
  return null;
}

// ---------------------------------------------------------------------------
// generateThesis  (exported)
// ---------------------------------------------------------------------------
// Primary export. Accepts worldData from world.js and returns the Claude
// thesis object, or null if every attempt including the fallback fails.
//
// worldData shape (all fields optional — engine degrades gracefully):
//   {
//     fred:           { [seriesId]: { value, date } }
//     treasury:       { date, y1, y2, y5, y10, y30 }
//     gold:           { price, date }
//     sectorMomentum: { [sectorName|etfTicker]: { momentum: number } }
//     headlines:      [{ title, seendate }]
//   }

export async function generateThesis(worldData = {}) {
  console.info('[thesis] Starting thesis generation…');

  // ── Main attempt (full prompt) ────────────────────────────────────────────
  const prompt = buildPrompt(worldData);
  let result   = await callWithRetry(prompt);

  if (result !== null) {
    return result;
  }

  // ── Fallback attempt (minimal prompt, no data) ────────────────────────────
  console.warn('[thesis] All main attempts failed. Trying minimal fallback prompt…');

  const fallbackPrompt = buildFallbackPrompt();

  try {
    const response = await callClaude({
      model:      CLAUDE_MODEL,
      max_tokens: 3000,
      system:     'You are a quantitative portfolio strategist.',
      messages:   [{ role: 'user', content: fallbackPrompt }],
    });

    const content   = response?.content ?? [];
    const textBlock = content.find(b => b.type === 'text');
    const raw       = textBlock?.text ?? '';

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    const sectorKeys = Object.keys(parsed?.sectorScores ?? {});
    if (sectorKeys.length >= MIN_SECTORS) {
      console.warn('[thesis] Fallback prompt succeeded with minimal data.');
      return parsed;
    }

    console.error(`[thesis] Fallback returned only ${sectorKeys.length} sectors — aborting.`);

  } catch (err) {
    console.error('[thesis] Fallback attempt failed —', err);
  }

  // Total failure.
  console.error('[thesis] generateThesis returning null after all attempts.');
  return null;
}
