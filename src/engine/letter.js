// =============================================================================
// FundLens v5.1 — src/engine/letter.js
// Generates a plain-language investor letter after scoring and allocation.
// Pipeline Step 10: called after outlier detection, before save.
//
// ⚠️  SEQUENTIAL CLAUDE CALL DISCIPLINE — MANDATORY  ⚠️
// All Claude API calls in engine files MUST be sequential with 1.2s delays.
// Never use Promise.all() for Claude calls. This has broken production 5+ times.
// 429 backoff: 3s / 6s / 9s.
//
// Rules:
//   - No localStorage.
//   - No web_search tool in Claude calls.
//   - All Claude calls route through callClaude() → /api/claude.
//   - Uses SONNET_MODEL (high-quality narrative generation).
// =============================================================================

import { SONNET_MODEL } from './constants.js';
import { callClaude }   from '../services/api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRE_CALL_DELAY_MS = 1200;       // 1.2s mandatory pre-call delay
const BACKOFF_SCHEDULE  = [3000, 6000, 9000];  // 429 retry delays
const MAX_RETRIES       = 3;

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// buildLetterPrompt
// ---------------------------------------------------------------------------
// Assembles the full prompt from scored funds, allocations, thesis, and
// sector scores. Designed for non-finance 401K investors.

function buildLetterPrompt(scoredFunds, allocations, thesis, sectorScores) {
  const lines = [];

  // ── Context header ────────────────────────────────────────────────────────
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  lines.push(`Date: ${today}`);
  lines.push('');

  // ── Macro thesis ──────────────────────────────────────────────────────────
  lines.push('=== CURRENT INVESTMENT THESIS ===');
  lines.push(typeof thesis === 'string' ? thesis : '(No thesis available)');
  lines.push('');

  // ── Sector scores ─────────────────────────────────────────────────────────
  lines.push('=== SECTOR SCORES (1–10, from thesis) ===');
  if (sectorScores && typeof sectorScores === 'object') {
    for (const [sector, data] of Object.entries(sectorScores)) {
      const score  = typeof data === 'object' ? data.score : data;
      const reason = typeof data === 'object' && data.reason ? ` — ${data.reason}` : '';
      lines.push(`  ${sector}: ${score}${reason}`);
    }
  } else {
    lines.push('(no sector scores available)');
  }
  lines.push('');

  // ── Recommended allocations ───────────────────────────────────────────────
  lines.push('=== RECOMMENDED FUND ALLOCATIONS ===');
  if (Array.isArray(allocations) && allocations.length > 0) {
    for (const a of allocations) {
      const pct = (a.allocation_pct * 100).toFixed(1);
      lines.push(`  ${a.ticker}: ${pct}% (tier: ${a.tier ?? 'N/A'})`);
    }
  } else {
    lines.push('(no allocations available)');
  }
  lines.push('');

  // ── Fund scoring detail (top funds by composite) ──────────────────────────
  lines.push('=== FUND SCORING DETAIL ===');
  const displayFunds = (scoredFunds ?? [])
    .filter(f => !f.isMoneyMarket)
    .slice(0, 8);

  for (const f of displayFunds) {
    lines.push(`  ${f.ticker} (${f.name ?? ''})`);
    lines.push(`    Composite: ${f.composite?.toFixed(2) ?? 'N/A'}`);
    lines.push(`    Positioning: ${f.sectorAlignment?.toFixed(2) ?? 'N/A'}`);
    lines.push(`    Momentum: ${f.momentum?.toFixed(2) ?? 'N/A'}`);
    lines.push(`    Quality: ${f.holdingsQuality?.toFixed(2) ?? 'N/A'}`);

    // Data quality caveats
    const dq = f.dataQuality ?? {};
    const flags = [];
    if (dq.sectorAlignmentFallback) flags.push('positioning used fallback');
    if (dq.momentumFallback)        flags.push('momentum used fallback');
    if (dq.holdingsQualityFallback) flags.push('quality used fallback');
    if (dq.qualityWeightHalved)     flags.push('quality weight halved (low coverage)');
    if (flags.length > 0) {
      lines.push(`    Data caveats: ${flags.join('; ')}`);
    }
    lines.push('');
  }

  // ── Writing instructions ──────────────────────────────────────────────────
  lines.push('=== WRITING INSTRUCTIONS ===');
  lines.push('Write a concise investor letter (300–500 words) for 401K plan participants.');
  lines.push('The audience is NOT finance professionals — use plain language, no jargon.');
  lines.push('');
  lines.push('The letter must:');
  lines.push('1. Open with a brief summary of the current economic environment and macro thesis.');
  lines.push('2. Name the top 3–5 recommended funds with their allocation percentages.');
  lines.push('3. For each recommended fund, explain WHY it is favored — which scoring');
  lines.push('   factors (Positioning, Momentum, Quality) drove its score. Be specific.');
  lines.push('4. Note any data quality caveats that investors should be aware of.');
  lines.push('5. Close with a clear, actionable "here\'s what to do" paragraph.');
  lines.push('');
  lines.push('Tone: confident but approachable. Think "trusted coworker who reads the');
  lines.push('financial news so you don\'t have to."');
  lines.push('');
  lines.push('Do NOT use bullet points or numbered lists in the letter body — write in');
  lines.push('flowing paragraphs. Fund names and percentages can be inline.');
  lines.push('');
  lines.push('Respond with ONLY the letter text. No JSON, no markdown fences, no preamble.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// generateInvestorLetter  (exported)
// ---------------------------------------------------------------------------
// Single export. Called as pipeline Step 10.
//
// Parameters:
//   scoredFunds  — sorted array from scoring.js
//   allocations  — from outlier.js (each: { ticker, allocation_pct, tier })
//   thesis       — thesis text string from thesis.js
//   sectorScores — { 'Technology': { score, reason }, ... } from thesis.js
//   onProgress   — optional callback for pipeline overlay
//
// Returns: { letter: string } on success, { letter: null } on failure.

export async function generateInvestorLetter(
  scoredFunds,
  allocations,
  thesis,
  sectorScores,
  onProgress,
) {
  console.info('[letter] Starting investor letter generation…');
  if (typeof onProgress === 'function') {
    onProgress({ step: 'letter', status: 'running', message: 'Writing investor letter…' });
  }

  const prompt = buildLetterPrompt(scoredFunds, allocations, thesis, sectorScores);

  // ── Sequential discipline: 1.2s pre-call delay ────────────────────────────
  await sleep(PRE_CALL_DELAY_MS);

  // ── Call with 429 backoff ─────────────────────────────────────────────────
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await callClaude({
        model:      SONNET_MODEL,
        max_tokens: 2000,
        system:     'You are a clear, confident financial communicator who explains investment strategy in plain language. You never use jargon. You write for busy people who want to know what to do with their 401K.',
        messages:   [{ role: 'user', content: prompt }],
      });

      // Extract text content.
      const content   = response?.content ?? [];
      const textBlock = content.find(b => b.type === 'text');
      const letter    = textBlock?.text?.trim() ?? '';

      if (!letter) {
        console.warn(`[letter] Attempt ${attempt + 1}: empty response.`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(BACKOFF_SCHEDULE[attempt] ?? 9000);
          continue;
        }
        break;
      }

      // Success.
      console.info(`[letter] Investor letter generated on attempt ${attempt + 1}.`);
      if (typeof onProgress === 'function') {
        onProgress({ step: 'letter', status: 'done', message: 'Investor letter complete.' });
      }
      return { letter };

    } catch (err) {
      const is429 = err?.message?.includes('429') || String(err).includes('429');
      const delay = BACKOFF_SCHEDULE[attempt] ?? 9000;

      if (is429) {
        console.warn(`[letter] Attempt ${attempt + 1}: rate-limited (429), waiting ${delay / 1000}s…`);
      } else {
        console.error(`[letter] Attempt ${attempt + 1}: error —`, err);
      }

      if (attempt < MAX_RETRIES - 1) {
        await sleep(delay);
      }
    }
  }

  // Total failure — pipeline continues without the letter.
  console.error('[letter] generateInvestorLetter returning null after all attempts.');
  if (typeof onProgress === 'function') {
    onProgress({ step: 'letter', status: 'done', message: 'Investor letter skipped (generation failed).' });
  }
  return { letter: null };
}
