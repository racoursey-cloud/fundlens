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
// Assembles the full prompt from scored funds, allocations, thesis, sector
// scores, and holdingsMap. Designed for non-finance 401K investors.

function buildLetterPrompt(scoredFunds, allocations, thesis, sectorScores, holdingsMap) {
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

  // Build a set of allocated tickers for quick lookup.
  const allocatedTickers = new Set(
    (allocations ?? []).filter(a => a.allocation_pct > 0).map(a => a.ticker)
  );

  for (const f of displayFunds) {
    const isAlloc = allocatedTickers.has(f.ticker);
    lines.push(`  ${f.ticker} (${f.name ?? ''})${isAlloc ? ' [RECOMMENDED]' : ''}`);
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

    // Top holdings for allocated funds — gives Claude concrete composition data.
    if (isAlloc && holdingsMap) {
      const raw      = holdingsMap[f.ticker];
      const holdings = Array.isArray(raw) ? raw : (raw?.holdings ?? []);
      const top10    = holdings
        .filter(h => h.weight > 0)
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 10);
      if (top10.length > 0) {
        lines.push('    Top holdings:');
        for (const h of top10) {
          const sector = h.sector || h.gics_sector || h.sectorName || '';
          lines.push(`      ${h.name ?? h.cusip ?? '?'}: ${h.weight?.toFixed(1)}%${sector ? ` (${sector})` : ''}`);
        }
      }
    }

    lines.push('');
  }

  // ── Writing instructions ──────────────────────────────────────────────────
  lines.push('=== WRITING INSTRUCTIONS ===');
  lines.push('Write a clear, approachable investor letter (400–600 words) for people');
  lines.push('managing their own 401K. These are NOT finance professionals.');
  lines.push('');
  lines.push('The letter must follow this exact structure:');
  lines.push('');
  lines.push('PARAGRAPH 1 — INTRODUCTION:');
  lines.push('Open by naming the recommended funds (the ones marked [RECOMMENDED] above)');
  lines.push('with their allocation percentages. Briefly state what the current economic');
  lines.push('environment looks like and why these particular funds make sense right now.');
  lines.push('Make the reader feel oriented — they should immediately know what you are');
  lines.push('recommending and roughly why.');
  lines.push('');
  lines.push('PARAGRAPHS 2–N — ONE PARAGRAPH PER RECOMMENDED FUND:');
  lines.push('For each recommended fund, write 2–3 sentences explaining why THIS specific');
  lines.push('fund is on the list. Be concrete:');
  lines.push('  - Reference what the fund actually holds (use the Top Holdings data above).');
  lines.push('    For example: "This fund has significant positions in [companies/sectors],');
  lines.push('    which are benefiting from [specific trend or condition]."');
  lines.push('  - Explain how the fund\'s composition connects to the current economic');
  lines.push('    environment described in the thesis.');
  lines.push('  - If the fund has strong momentum, say what that means in plain terms');
  lines.push('    (e.g., "it has been gaining ground steadily over recent months").');
  lines.push('  - Do NOT just say "it scored well on positioning" — explain WHAT about its');
  lines.push('    positioning makes it a good choice right now.');
  lines.push('');
  lines.push('FINAL PARAGRAPH — SUMMARY:');
  lines.push('Wrap up by explaining how these funds work together as a group. Why does');
  lines.push('this combination make sense? What balance or diversification does it provide?');
  lines.push('End with a confident, reassuring note — the reader should feel comfortable');
  lines.push('with the recommendation.');
  lines.push('');
  lines.push('TONE AND STYLE:');
  lines.push('- Write like a helpful coworker who happens to follow the markets closely.');
  lines.push('- No financial jargon. If you must use a term like "momentum" or "sector');
  lines.push('  exposure," briefly explain what it means in context.');
  lines.push('- No bullet points or numbered lists — write in flowing paragraphs.');
  lines.push('- Fund tickers and percentages can appear inline in the prose.');
  lines.push('- Be specific and concrete, never vague or generic.');
  lines.push('- The reader should finish the letter understanding WHY each fund was chosen,');
  lines.push('  not just THAT it was chosen.');
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
//   holdingsMap  — { TICKER: { holdings, meta } } from edgar.js
//   onProgress   — optional callback for pipeline overlay
//
// Returns: { letter: string } on success, { letter: null } on failure.

export async function generateInvestorLetter(
  scoredFunds,
  allocations,
  thesis,
  sectorScores,
  holdingsMap,
  onProgress,
) {
  console.info('[letter] Starting investor letter generation…');
  if (typeof onProgress === 'function') {
    onProgress({ step: 'letter', status: 'running', message: 'Writing investor letter…' });
  }

  const prompt = buildLetterPrompt(scoredFunds, allocations, thesis, sectorScores, holdingsMap);

  // ── Sequential discipline: 1.2s pre-call delay ────────────────────────────
  await sleep(PRE_CALL_DELAY_MS);

  // ── Call with 429 backoff ─────────────────────────────────────────────────
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await callClaude({
        model:      SONNET_MODEL,
        max_tokens: 2000,
        system:     'You are a clear, down-to-earth writer who explains investment choices in plain language. You write for everyday people who want to understand what to do with their 401K and, more importantly, why. You never use jargon. You are specific and concrete — you reference actual fund holdings and real economic conditions, not abstract scores or vague generalities.',
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
