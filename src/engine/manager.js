// src/engine/manager.js
// FundLens v5 — Manager Quality Scoring Engine
// Scores each fund's management quality 1-10 using Claude's knowledge.
// Checks Supabase cache first (30-day TTL). Only calls Claude for uncached funds.
//
// ============================================================
// ⚠️  CRITICAL: SEQUENTIAL CLAUDE CALLS ONLY
// ============================================================
// All Claude API calls in this file MUST be sequential.
// DO NOT use Promise.all(), Promise.allSettled(), or any form
// of concurrent Claude call. This has crashed production 5+ times.
// Pattern: one call → await → 1.2s delay → next call.
// ============================================================

import { callClaude }                          from '../services/api.js';
import { getManagerScores, saveManagerScores } from '../services/cache.js';
import { CLAUDE_MODEL }                        from './constants.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the manager quality scoring prompt for a set of funds.
 */
function buildPrompt(funds) {
  const fundList = funds
    .map(f => `  { "ticker": "${f.ticker}", "name": "${f.name}" }`)
    .join('\n');

  return `You are a professional fund analyst. Score each mutual fund's management quality based on your knowledge.

FUNDS TO SCORE:
${fundList}

Evaluation criteria:
- Manager tenure and continuity
- Parent company stability and reputation
- Fee structure relative to category
- AUM viability (not too small to survive, not so large it hinders performance)
- Historical consistency and performance attribution

SCORING CRITERIA — score (1-10):
10 = World-class management, multi-decade track record, exceptional stewardship
7-9 = Strong, experienced team with proven execution and sound process
5-6 = Adequate management, no red flags, meets category expectations
3-4 = Concerns about management changes, underperformance, or fee drag
1-2 = Significant management issues — high turnover, poor oversight, or viability risk

IMPORTANT: Use the full 1-10 range. Avoid clustering all funds in the 5-6 band. Funds with exceptional or problematic management should receive scores at the tails.

Respond ONLY with valid JSON, no markdown, no commentary:
{"scores":{"TICKER":{"score":N,"reasoning":"1 sentence max"}}}`;
}

/**
 * Execute a single batched Claude call for manager scoring with retry logic.
 * Returns the parsed scores object or null on failure.
 */
async function callClaudeForManagers(funds) {
  const prompt = buildPrompt(funds);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await callClaude({
        model:      CLAUDE_MODEL,
        max_tokens: 2000,
        messages:   [{ role: 'user', content: prompt }],
      });

      const text = response?.content?.[0]?.text ?? '';

      // Strip markdown fences if present
      const clean = text.replace(/```json|```/gi, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        console.warn(`[manager] JSON parse failed on attempt ${attempt}:`, text.slice(0, 200));
        if (attempt < 3) {
          await sleep(3000);
          continue;
        }
        return null;
      }

      if (!parsed?.scores || typeof parsed.scores !== 'object') {
        console.warn(`[manager] No scores object in response (attempt ${attempt})`);
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
      console.warn(`[manager] Attempt ${attempt} failed (${err.message}). Waiting ${waitMs}ms.`);
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
 * Score each fund's management quality.
 * Hits cache first; only calls Claude for uncached or expired funds.
 *
 * @param {Array<{ticker: string, name: string}>} funds
 * @param {Function} [onProgress] — optional (message: string) => void callback
 * @returns {Promise<Object>} { TICKER: { score, reasoning } } — always returns an object
 */
export async function scoreManagers(funds, onProgress) {
  if (!funds || funds.length === 0) {
    console.warn('[manager] No funds provided.');
    return {};
  }

  onProgress?.('Checking manager score cache…');

  const tickers = funds.map(f => f.ticker.toUpperCase());

  // Load whatever is already cached (30-day TTL enforced inside getManagerScores)
  const cached = await getManagerScores(tickers);

  // Determine which funds need fresh scoring
  const uncachedFunds = funds.filter(
    f => !cached[f.ticker.toUpperCase()]
  );

  const result = { ...cached };

  if (uncachedFunds.length === 0) {
    onProgress?.('All manager scores loaded from cache.');
    return result;
  }

  onProgress?.(`Scoring ${uncachedFunds.length} fund manager(s) with Claude…`);

  // ⚠️ SINGLE BATCHED CALL for all uncached funds.
  // If this ever needs to be split into multiple batches,
  // each call MUST be separated by: await sleep(1200)
  const rawScores = await callClaudeForManagers(uncachedFunds);

  // Build the save array and merge results
  const toCache = [];
  const now     = new Date().toISOString();

  for (const fund of uncachedFunds) {
    const key = fund.ticker.toUpperCase();
    const raw = rawScores
      ? (rawScores[fund.ticker] ?? rawScores[key] ?? null)
      : null;

    if (raw && raw.score != null) {
      const score     = Math.max(1, Math.min(10, Number(raw.score)));
      const reasoning = raw.reasoning ?? '';
      result[key] = { score, reasoning };
      toCache.push({ ticker: key, score, reasoning, cached_at: now });
    } else {
      // Claude didn't return a score for this fund — use neutral fallback
      result[key] = { score: 5, reasoning: 'No assessment available.' };
      toCache.push({ ticker: key, score: 5, reasoning: 'No assessment available.', cached_at: now });
    }
  }

  // Persist to Supabase (best-effort — don't let a cache write failure abort scoring)
  try {
    await saveManagerScores(toCache);
  } catch (err) {
    console.warn('[manager] Cache save failed (non-fatal):', err.message);
  }

  onProgress?.('Manager scoring complete.');

  // ⚠️ 1.2s courtesy delay before returning — callers may chain Claude calls
  await sleep(1200);

  return result;
}
