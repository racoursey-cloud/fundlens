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
  lines.push('Write a 400–600 word letter for 401K participants. Not finance professionals.');
  lines.push('');
  lines.push('STRUCTURE:');
  lines.push('');
  lines.push('PARAGRAPH 1 — INTRODUCTION:');
  lines.push('Name the recommended funds with percentages. Set the scene: what is happening');
  lines.push('in the economy RIGHT NOW that makes these the right picks? Use the specific');
  lines.push('numbers from the thesis (oil price, gold price, consumer confidence, rates).');
  lines.push('Don\'t just say "challenging environment" — say what\'s actually happening.');
  lines.push('');
  lines.push('PARAGRAPHS 2–N — ONE PARAGRAPH PER RECOMMENDED FUND:');
  lines.push('For each fund, make a SPECIFIC argument for why it belongs in the portfolio');
  lines.push('right now. The argument must connect what the fund holds to what is happening');
  lines.push('in the world:');
  lines.push('  - Name actual companies or describe specific sector concentrations from the');
  lines.push('    Top Holdings data. Use actual weight percentages when they are notable.');
  lines.push('  - Make a direct causal link: "[Company/sector] benefits because [specific');
  lines.push('    current condition]." Example: "Its 8% position in Exxon and Chevron');
  lines.push('    means it profits directly from $105 oil."');
  lines.push('  - If a fund has no Top Holdings data, focus on its performance trend and');
  lines.push('    tier — do NOT apologize for missing data or say "limited visibility."');
  lines.push('  - Each fund paragraph should make the reader think "oh, that makes sense"');
  lines.push('    — not "that could describe any fund."');
  lines.push('');
  lines.push('FINAL PARAGRAPH — SUMMARY:');
  lines.push('Explain what this combination gives the investor as a whole. What risks are');
  lines.push('covered? What opportunities are captured? End with confidence — the reader');
  lines.push('should feel this is a smart, well-reasoned set of choices.');
  lines.push('');
  lines.push('VOICE:');
  lines.push('Main street, not Wall Street. Talk to the reader like they\'re a coworker');
  lines.push('you respect. Matter-of-fact — no hype, no doom, just what\'s happening and');
  lines.push('why these funds make sense because of it. You can use "I" and contractions.');
  lines.push('Present the economic picture straight down the middle. Don\'t lead the');
  lines.push('investor toward bull or bear — just give them the facts and connect the dots.');
  lines.push('If two data points seem to conflict, think about why they coexist and');
  lines.push('explain it — don\'t just flag it as strange.');
  lines.push('');
  lines.push('OTHER RULES:');
  lines.push('- No bullet points or numbered lists — flowing paragraphs only.');
  lines.push('- No financial jargon without immediately explaining it.');
  lines.push('- Every claim must reference a specific number, company, or condition.');
  lines.push('- Be specific. If something could describe any fund in any market, cut it.');
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
        system:     'You explain investment choices the way a sharp coworker would — main street language, matter-of-fact, no hype or doom. You connect specific fund holdings to specific things happening in the economy. You present the picture straight down the middle and let the facts speak.',
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
