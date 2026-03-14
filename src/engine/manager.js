// FundLens v4 -- Manager quality scoring engine
// Asks Claude to score each fund's management quality on a scale of 1.0-10.0.
// Manager quality is independent of macro environment -- it measures the people
// and organisation running the fund, not how well it fits current conditions.
//
// Architecture notes:
// - 30-day Supabase cache per fund. Manager quality rarely changes week to week.
//   Cache hits return immediately without calling Claude.
// - Each fund scored SEQUENTIALLY with delays between API calls.
//   Cache hits are instant so only stale/missing funds actually hit the API.
// - 3 retries per fund. Failures fall back to score=5 (neutral), confidence=low.
//   manager.js never throws -- a fallback score is always returned.
// - max_tokens: 2000 per call.
// - ALERTS are passed as notable facts, NOT as negative signals. Each alert
//   carries its own sentiment tag (positive/negative/neutral). Claude is
//   instructed to assess each fact on its own merits.
// - Confidence field (high/medium/low) returned alongside score so pipeline
//   and DataQualityBanner can surface low-confidence scores to the user.
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// !! SEQUENTIAL PROCESSING IS MANDATORY -- DO NOT CONVERT TO Promise.all()    !!
// !! The Claude API rate-limits concurrent requests. Parallel calls cause     !!
// !! 429 errors across ALL funds, which degrades every other pipeline step.   !!
// !! This has broken production multiple times. Do not do it.                !!
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

import { CLAUDE_MODEL, ALERTS } from './constants.js';
import { getManagerScore, setManagerScore } from '../services/cache.js';

const MANAGER_MAX_TOKENS  = 2000;
const MANAGER_RETRIES     = 3;
const MANAGER_FALLBACK    = { score: 5.0, reasoning: 'Insufficient data to score manager quality.', confidence: 'low' };
const MANAGER_CACHE_DAYS  = 30;
const DELAY_BETWEEN_FUNDS_MS = 1200; // pause between sequential API calls
const DELAY_ON_429_BASE_MS = 3000;   // base backoff when rate-limited (multiplied by attempt)

// -- Build prompt for a single fund ------------------------------------------
function buildManagerPrompt(fund, expenseData) {
  const alerts = ALERTS[fund.ticker] ?? [];
  const expense = expenseData?.[fund.ticker];

  const lines = [];
  lines.push('Score the MANAGEMENT QUALITY of this mutual fund on a scale of 1.0 to 10.0.');
  lines.push('');
  lines.push(`Fund:   ${fund.name}`);
  lines.push(`Ticker: ${fund.ticker}`);
  lines.push('');

  // Notable facts -- neutral framing, sentiment tag shown for context
  if (alerts.length) {
    lines.push('Notable facts (each may be positive, negative, or neutral -- assess on its own merits):');
    alerts.forEach(a => {
      const tag = a.sentiment === 'positive' ? '(+)' : a.sentiment === 'negative' ? '(-)' : '(~)';
      lines.push(`  ${tag} ${a.text}`);
    });
  } else {
    lines.push('Notable facts: none on record');
  }
  lines.push('');

  // Expense ratio if available
  if (expense) {
    lines.push(`Expense ratio: ${expense.net ?? expense.gross ?? '?'}% net`);
    if (expense.note) lines.push(`  Note: ${expense.note}`);
    lines.push('');
  }

  lines.push('Consider:');
  lines.push('  - Parent company reputation, financial stability, and shareholder orientation');
  lines.push('  - Portfolio manager tenure, track record, and consistency of execution');
  lines.push('  - Any leadership transitions, AUM concerns, or fee changes listed above');
  lines.push('  - Each notable fact should be weighed independently -- presence of a fact');
  lines.push('    is not inherently negative. A new manager could be an upgrade.');
  lines.push('  - Overall operational quality relative to fund category peers');
  lines.push('');
  lines.push('Respond ONLY with valid JSON in this exact format:');
  lines.push('{');
  lines.push('  "score": <number 1.0-10.0, one decimal place>,');
  lines.push('  "reasoning": "<2-3 sentences explaining the score>",');
  lines.push('  "confidence": "<high | medium | low>"');
  lines.push('}');
  lines.push('');
  lines.push('Score guidance (USE THE FULL 1-10 RANGE):');
  lines.push('  9-10: Elite — top-tier fund family (Vanguard, Fidelity, PIMCO), long-tenured');
  lines.push('        PMs with strong track records, low fees, excellent stewardship.');
  lines.push('  7-8:  Strong — reputable organization, experienced management, competitive fees.');
  lines.push('  5-6:  Average — adequate management, no red flags but nothing distinctive.');
  lines.push('  3-4:  Below average — high fees, short PM tenure, organizational concerns,');
  lines.push('        or limited transparency.');
  lines.push('  1-2:  Poor — significant red flags: regulatory issues, excessive fees,');
  lines.push('        revolving-door management, AUM collapse, or known controversies.');
  lines.push('');
  lines.push('CRITICAL: A Vanguard index fund and an obscure boutique fund with no track');
  lines.push('record CANNOT both score 5-6. Differentiate based on what you actually know');
  lines.push('about the fund family and management. If you know the firm well, score');
  lines.push('decisively. If you know little, score conservatively AND set confidence=low.');
  lines.push('');
  lines.push('confidence guidance:');
  lines.push('  high   -- well-known fund family, strong data, clear track record');
  lines.push('  medium -- some knowledge gaps or ambiguous signals');
  lines.push('  low    -- limited information, obscure fund, or highly uncertain situation');
  lines.push('');
  lines.push('Do not include any text outside the JSON object.');

  return lines.join('\n');
}

// -- Score a single fund with retries ----------------------------------------
async function scoreOneFund(fund, expenseData) {
  // Check 30-day cache first
  try {
    const cached = await getManagerScore(fund.ticker);
    if (cached) {
      return {
        ticker:     fund.ticker,
        score:      cached.score,
        reasoning:  cached.reasoning,
        confidence: cached.confidence ?? 'medium',
        fromCache:  true,
      };
    }
  } catch (err) {
    console.warn('manager.js: cache read failed for', fund.ticker, err.message);
  }

  // Call Claude with retries
  const prompt = buildManagerPrompt(fund, expenseData);

  for (let attempt = 0; attempt <= MANAGER_RETRIES; attempt++) {
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: MANAGER_MAX_TOKENS,
          system:     'You are a fund analyst evaluating management quality. You are decisive and use the full 1-10 scale. Well-known fund families with strong reputations score high. Unknown or problematic managers score low. You never default to the midpoint. You respond with only valid JSON.',
          messages:   [{ role: 'user', content: prompt }],
        }),
      });

      // On 429, use longer backoff before retry
      if (res.status === 429) {
        if (attempt < MANAGER_RETRIES) {
          const backoff = DELAY_ON_429_BASE_MS * (attempt + 1);
          console.warn(`manager.js: 429 rate-limited for ${fund.ticker}, waiting ${backoff}ms before retry ${attempt + 1}`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        throw new Error('Claude API 429 (rate limited)');
      }

      if (!res.ok) throw new Error('Claude API ' + res.status);

      const data = await res.json();
      const text = (data.content || []).map(b => b.text || '').join('').trim();
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      const score = parseFloat(parsed.score);
      if (isNaN(score) || score < 1 || score > 10) {
        throw new Error('Score out of range: ' + parsed.score);
      }

      const validConfidence = ['high', 'medium', 'low'];
      const confidence = validConfidence.includes(parsed.confidence)
        ? parsed.confidence
        : 'medium';

      const result = {
        ticker:     fund.ticker,
        score:      Math.round(score * 10) / 10,
        reasoning:  parsed.reasoning || '',
        confidence,
        fromCache:  false,
      };

      // Persist to cache -- non-fatal if it fails
      try {
        await setManagerScore(fund.ticker, result.score, result.reasoning, confidence);
      } catch (err) {
        console.warn('manager.js: cache write failed for', fund.ticker, err.message);
      }

      return result;

    } catch (err) {
      if (attempt < MANAGER_RETRIES) {
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      console.warn('manager.js: scoring failed for', fund.ticker, 'after', MANAGER_RETRIES + 1, 'attempts:', err.message);
    }
  }

  // Fallback -- neutral score, never throws
  return {
    ticker:     fund.ticker,
    score:      MANAGER_FALLBACK.score,
    reasoning:  MANAGER_FALLBACK.reasoning,
    confidence: MANAGER_FALLBACK.confidence,
    fromCache:  false,
  };
}

// -- Public entry point ------------------------------------------------------
// funds:       array of { ticker, name }
// expenseData: optional { [ticker]: { gross, net, note } } from expenses.js
//              pass null if expenses have not been fetched yet
export async function scoreManagers(funds, expenseData = null) {
  if (!funds?.length) return {};

  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  // !! SEQUENTIAL -- DO NOT CONVERT TO Promise.all(). SEE FILE HEADER. !!
  // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  const scores = {};
  let apiCallsMade = 0;

  for (let i = 0; i < funds.length; i++) {
    const fund = funds[i];
    const result = await scoreOneFund(fund, expenseData);
    scores[result.ticker] = result;

    // Only delay between API calls, not after cache hits
    if (!result.fromCache) {
      apiCallsMade++;
      // Delay before next fund (skip after the very last one)
      if (i < funds.length - 1) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_FUNDS_MS));
      }
    }
  }

  return scores;
}
