// src/engine/mandate.js
// FundLens v5 — Mandate Scoring Engine
// Scores each fund's investment mandate against current macro conditions.
// This is the single most important scoring factor (40% weight).
//
// ============================================================
// ⚠️  CRITICAL: SEQUENTIAL CLAUDE CALLS ONLY
// ============================================================
// All Claude API calls in this file MUST be sequential.
// DO NOT use Promise.all(), Promise.allSettled(), or any form
// of concurrent Claude call. This has crashed production 5+ times.
// Pattern: one call → await → 1.2s delay → next call.
// ============================================================

import { callClaude } from '../services/api.js';
import { CLAUDE_MODEL } from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build a compact macro summary string from worldData and sectorScores.
 */
function buildMacroSummary(worldData, sectorScores) {
  const fred = worldData?.fred_data ?? {};
  const headlines = worldData?.headlines ?? [];
  const treasury = worldData?.treasury_data ?? {};

  // FRED key values — pull most recent observation
  const fredLines = [];
  for (const [seriesId, obs] of Object.entries(fred)) {
    if (Array.isArray(obs) && obs.length > 0) {
      const latest = obs[0];
      fredLines.push(`${seriesId}: ${latest.value} (${latest.date})`);
    }
  }

  // Treasury yield spreads
  const yieldLines = [];
  if (treasury.y2 != null && treasury.y10 != null) {
    yieldLines.push(`2s10s spread: ${(treasury.y10 - treasury.y2).toFixed(2)}%`);
  }
  if (treasury.y10 != null) {
    yieldLines.push(`10Y yield: ${treasury.y10}%`);
  }

  // Sector scores summary (top 5 and bottom 3 by score)
  const sectorLines = [];
  if (sectorScores && typeof sectorScores === 'object') {
    const sorted = Object.entries(sectorScores)
      .filter(([, v]) => v?.score != null)
      .sort(([, a], [, b]) => b.score - a.score);
    const top = sorted.slice(0, 5).map(([s, v]) => `${s}: ${v.score.toFixed(1)}`);
    const bottom = sorted.slice(-3).map(([s, v]) => `${s}: ${v.score.toFixed(1)}`);
    if (top.length)    sectorLines.push(`Top sectors: ${top.join(', ')}`);
    if (bottom.length) sectorLines.push(`Weak sectors: ${bottom.join(', ')}`);
  }

  // Dominant theme
  const theme = worldData?.dominant_theme ?? 'Unknown';
  const stance = worldData?.macro_stance ?? '';

  // Top 12 headlines
  const headlineList = headlines
    .slice(0, 12)
    .map((h, i) => `${i + 1}. ${h.title ?? h}`)
    .join('\n');

  return [
    `DOMINANT THEME: ${theme}${stance ? ` | MACRO STANCE: ${stance}` : ''}`,
    '',
    'KEY ECONOMIC DATA:',
    ...fredLines,
    ...yieldLines,
    '',
    'SECTOR SCORES (1-10):',
    ...sectorLines,
    '',
    'TOP HEADLINES:',
    headlineList,
  ].join('\n');
}

/**
 * Build the prompt for a batch mandate scoring call.
 */
function buildPrompt(funds, macroSummary) {
  const fundList = funds
    .map(f => `  { "ticker": "${f.ticker}", "name": "${f.name}" }`)
    .join('\n');

  return `You are a professional fund analyst. Score each mutual fund's mandate alignment with current macro conditions.

CURRENT MACRO ENVIRONMENT:
${macroSummary}

FUNDS TO SCORE:
${fundList}

SCORING CRITERIA — mandateScore (1-10):
10 = Fund's mandate directly captures dominant macro themes
8-9 = Strong alignment — fund benefits meaningfully from current conditions
6-7 = Moderate fit — mixed exposure, some tailwinds and headwinds
4-5 = Neutral — fund is relatively environment-agnostic
2-3 = Headwinds — fund's focus areas face current macro challenges
1 = Poor fit — fund mandate directly opposes current conditions

IMPORTANT: Use the full 1-10 range. If all funds score between 4-7, your analysis lacks conviction. At least 3 funds should score above 7 and at least 3 should score below 5.

Respond ONLY with valid JSON, no markdown, no commentary:
{"scores":{"TICKER":{"mandateScore":N,"reasoning":"1 sentence max"}}}`;
}

/**
 * Execute a single Claude call for mandate scoring with retry logic.
 * Returns the parsed scores object or null on failure.
 */
async function callClaudeForMandates(funds, macroSummary) {
  const prompt = buildPrompt(funds, macroSummary);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await callClaude({
        model:      CLAUDE_MODEL,
        max_tokens: 2200,
        messages:   [{ role: 'user', content: prompt }],
      });

      const text = response?.content?.[0]?.text ?? '';

      // Strip markdown fences if present
      const clean = text.replace(/```json|```/gi, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        console.warn(`[mandate] JSON parse failed on attempt ${attempt}:`, text.slice(0, 200));
        if (attempt < 3) {
          await sleep(3000);
          continue;
        }
        return null;
      }

      if (!parsed?.scores || typeof parsed.scores !== 'object') {
        console.warn(`[mandate] No scores object in response (attempt ${attempt})`);
        if (attempt < 3) {
          await sleep(3000);
          continue;
        }
        return null;
      }

      // Validate coverage: at least 70% of funds scored
      const scoredCount = Object.keys(parsed.scores).length;
      const requiredCount = Math.floor(funds.length * 0.7);
      if (scoredCount < requiredCount) {
        console.warn(
          `[mandate] Coverage too low: ${scoredCount}/${funds.length} (attempt ${attempt})`
        );
        if (attempt < 3) {
          await sleep(3000);
          continue;
        }
        return null;
      }

      return parsed.scores;

    } catch (err) {
      const is429 = err?.message?.includes('429') || err?.status === 429;
      const waitMs = is429 ? 15_000 : 3_000 * attempt;
      console.warn(`[mandate] Attempt ${attempt} failed (${err.message}). Waiting ${waitMs}ms.`);
      if (attempt < 3) {
        await sleep(waitMs);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Score each fund's mandate alignment against current macro conditions.
 *
 * @param {Array<{ticker: string, name: string}>} funds
 * @param {Object} worldData   — from cached_world_data (fred, headlines, treasury, theme)
 * @param {Object} sectorScores — map of { sectorName: { score } }
 * @param {Function} [onProgress] — optional (message: string) => void callback
 * @returns {Promise<Object|null>} { TICKER: { mandateScore, reasoning } } or null
 */
export async function scoreMandates(funds, worldData, sectorScores, onProgress) {
  if (!funds || funds.length === 0) {
    console.warn('[mandate] No funds provided.');
    return null;
  }

  onProgress?.('Scoring mandate alignment…');

  const macroSummary = buildMacroSummary(worldData, sectorScores);

  // ⚠️ SINGLE BATCHED CALL — all funds in one request.
  // If this ever needs to be split into multiple calls,
  // each call MUST be separated by await sleep(1200).
  const rawScores = await callClaudeForMandates(funds, macroSummary);

  if (!rawScores) {
    console.error('[mandate] All attempts failed. Returning null (scoring.js will use 5.0 fallbacks).');
    return null;
  }

  // Normalise: uppercase tickers, clamp scores 1-10, fill missing funds
  const result = {};

  for (const fund of funds) {
    const key = fund.ticker.toUpperCase();
    const raw = rawScores[fund.ticker] ?? rawScores[key] ?? null;

    if (raw && raw.mandateScore != null) {
      result[key] = {
        mandateScore: Math.max(1, Math.min(10, Number(raw.mandateScore))),
        reasoning:    raw.reasoning ?? '',
      };
    } else {
      // Fund not scored by Claude — caller will apply 5.0 fallback
      result[key] = null;
    }
  }

  onProgress?.('Mandate scoring complete.');
  return result;
}
