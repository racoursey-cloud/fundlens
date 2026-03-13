// FundLens v4 — Investment Thesis Generator
// Takes world data (FRED, Treasury, headlines) and makes ONE Claude call to
// produce a macro thesis, stance, and sector scores. This is the "thesis-first"
// step — Claude forms a macro view BEFORE individual funds are scored.
//
// Architecture notes:
// - Pure function: world data in, thesis out. No cache reads or writes.
// - Pipeline.js handles caching; this file is stateless by design.
// - All Claude calls go through callClaude() in api.js (routes to /api/claude).
// - On any failure, returns a neutral fallback — never throws.

import { GICS_SECTORS } from './constants.js';
import { callClaude }   from '../services/api.js';

// ── Fallback object returned on any error ─────────────────────────────────────
function buildFallback() {
  const sectorScores = {};
  for (const sector of Object.keys(GICS_SECTORS)) {
    sectorScores[sector] = { score: 5.0, reasoning: 'No thesis data available.' };
  }
  return {
    investmentThesis: 'Thesis generation failed. Scores based on available data only.',
    dominantTheme:    'Unavailable',
    macroStance:      'neutral',
    sectorScores,
  };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildFredBlock(fredData) {
  if (!fredData || !Object.keys(fredData).length) {
    return 'FRED economic data: [unavailable]';
  }
  const lines = Object.entries(fredData).map(([seriesId, entry]) => {
    if (!entry || entry.value == null) {
      return `  ${seriesId} (${entry?.label ?? seriesId}): [unavailable]`;
    }
    return `  ${seriesId} (${entry.label}): ${entry.value} as of ${entry.date}`;
  });
  return `FRED Economic Indicators:\n${lines.join('\n')}`;
}

function buildTreasuryBlock(treasuryData) {
  if (!treasuryData) {
    return 'Treasury Yield Curve: [unavailable]';
  }
  const { date, y1, y2, y5, y10, y30, spreads } = treasuryData;
  const fmt = v => (v != null ? `${v}%` : '[unavailable]');
  const fmtS = v => (v != null ? `${v > 0 ? '+' : ''}${v}%` : '[unavailable]');
  return [
    `Treasury Yield Curve (as of ${date ?? '[unknown date]'}):`,
    `  1Y: ${fmt(y1)}  2Y: ${fmt(y2)}  5Y: ${fmt(y5)}  10Y: ${fmt(y10)}  30Y: ${fmt(y30)}`,
    `  Spreads:`,
    `    Short end  (2Y-1Y):          ${fmtS(spreads?.shortEnd)} — near-term rate expectations`,
    `    Belly      (5Y vs 2Y/10Y):   ${fmtS(spreads?.belly)}   — curve curvature`,
    `    Classic    (10Y-2Y):         ${fmtS(spreads?.classic)} — recession predictor`,
    `    Long end   (30Y-10Y):        ${fmtS(spreads?.longEnd)} — long-term inflation expectations`,
  ].join('\n');
}

function buildHeadlinesBlock(headlines) {
  if (!headlines?.length) {
    return 'Recent Financial Headlines: [unavailable]';
  }
  const top = headlines.slice(0, 15);
  const lines = top.map((h, i) => `  ${i + 1}. [${h.source}] ${h.title}`);
  return `Recent Financial Headlines (top ${top.length}):\n${lines.join('\n')}`;
}

function buildSectorList() {
  const sectors = Object.keys(GICS_SECTORS).join(', ');
  return `GICS Sectors to score (all 11): ${sectors}`;
}

// ── JSON schema description embedded in prompt ────────────────────────────────
const JSON_SCHEMA = `
Respond with ONLY a valid JSON object in this exact shape — no markdown, no preamble:
{
  "investmentThesis": "<exactly 3 sentences: (1) what is happening in the world right now, (2) what that means for fund investors, (3) the one signal to watch that could change this>",
  "dominantTheme": "<1 short phrase, e.g. 'Fed pivot uncertainty' or 'stagflation risk'>",
  "macroStance": "<one of: bullish | bearish | neutral | transitional>",
  "sectorScores": {
    "<sector name>": { "score": <number 1.0–10.0, one decimal place>, "reasoning": "<1 sentence>" },
    ... (all 11 GICS sectors required)
  }
}
Score guidance: 8–10 = macro tailwinds strongly favor this sector now. 5 = neutral. 1–3 = macro headwinds. Use the full range.
`.trim();

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a macro investment thesis from world data.
 *
 * @param {object} worldData - { fredData, headlines, treasuryData } from world.js
 * @returns {object} { investmentThesis, dominantTheme, macroStance, sectorScores }
 *
 * Never throws. Returns neutral fallback on any failure.
 */
export async function generateThesis(worldData = {}) {
  const { fredData = {}, headlines = [], treasuryData = null } = worldData;

  const system = [
    'You are a senior macro strategist at a large asset management firm.',
    'Your job is to interpret current economic data and form a concise, actionable investment thesis.',
    'You are precise, data-driven, and honest about uncertainty.',
    'You score sectors purely on macroeconomic fit — not on individual fund quality.',
    'You always respond with only valid JSON. No markdown, no explanation outside the JSON.',
  ].join(' ');

  const user = [
    buildFredBlock(fredData),
    '',
    buildTreasuryBlock(treasuryData),
    '',
    buildHeadlinesBlock(headlines),
    '',
    buildSectorList(),
    '',
    JSON_SCHEMA,
  ].join('\n');

  try {
    const result = await callClaude({ system, user, maxTokens: 3000, json: true });

    // Validate shape — if Claude returns something malformed, fall back gracefully
    if (
      typeof result?.investmentThesis !== 'string' ||
      typeof result?.dominantTheme   !== 'string' ||
      typeof result?.macroStance      !== 'string' ||
      typeof result?.sectorScores     !== 'object' ||
      result.sectorScores === null
    ) {
      console.warn('thesis.js: Claude response missing required fields, using fallback', result);
      return buildFallback();
    }

    // Ensure macroStance is one of the four allowed values
    const validStances = new Set(['bullish', 'bearish', 'neutral', 'transitional']);
    if (!validStances.has(result.macroStance)) {
      console.warn('thesis.js: unexpected macroStance value:', result.macroStance, '— defaulting to neutral');
      result.macroStance = 'neutral';
    }

    // Ensure all 11 sectors are present in sectorScores; fill any missing with fallback
    for (const sector of Object.keys(GICS_SECTORS)) {
      if (!result.sectorScores[sector] || typeof result.sectorScores[sector].score !== 'number') {
        console.warn('thesis.js: missing or invalid sector score for', sector, '— using fallback');
        result.sectorScores[sector] = { score: 5.0, reasoning: 'No thesis data available.' };
      } else {
        // Clamp score to 1.0–10.0, round to 1 decimal
        const raw = result.sectorScores[sector].score;
        result.sectorScores[sector].score = Math.round(Math.min(10, Math.max(1, raw)) * 10) / 10;
      }
    }

    return {
      investmentThesis: result.investmentThesis,
      dominantTheme:    result.dominantTheme,
      macroStance:      result.macroStance,
      sectorScores:     result.sectorScores,
    };

  } catch (err) {
    console.warn('thesis.js: Claude call failed, using fallback', err.message);
    return buildFallback();
  }
}
