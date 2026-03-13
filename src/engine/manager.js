// FundLens v4 — Manager quality scoring engine
// Asks Claude to score each fund's management quality on a scale of 1.0-10.0.
// Manager quality is independent of macro environment — it measures the people
// and organisation running the fund, not how well it fits current conditions.
//
// Architecture notes:
// - 30-day Supabase cache per fund. Manager quality rarely changes week to week.
//   Cache hits return immediately without calling Claude.
// - Each fund scored concurrently via Promise.all. Cache hits are instant so
//   only stale/missing funds actually hit the API.
// - 3 retries per fund. Failures fall back to score=5 (neutral), confidence=low.
//   manager.js never throws — a fallback score is always returned.
// - max_tokens: 2000 per call.
// - ALERTS are passed as notable facts, NOT as negative signals. Each alert
//   carries its own sentiment tag (positive/negative/neutral). Claude is
//   instructed to assess each fact on its own merits.
// - Confidence field (high/medium/low) returned alongside score so pipeline
//   and DataQualityBanner can surface low-confidence scores to the user.

import { CLAUDE_MODEL, ALERTS } from './constants.js';
import { getManagerScore, setManagerScore } from '../services/cache.js';

const MANAGER_MAX_TOKENS  = 2000;
const MANAGER_RETRIES     = 3;
const MANAGER_FALLBACK    = { score: 5.0, reasoning: 'Insufficient data to score manager quality.', confidence: 'low' };
const MANAGER_CACHE_DAYS  = 30;

// — Build prompt for a single fund ————————————————————————————————————————
function buildManagerPrompt(fund, expenseData) {
  const alerts = ALERTS[fund.ticker] ?? [];
  const expense = expenseData?.[fund.ticker];

  const lines = [];
  lines.push('Score the MANAGEMENT QUALITY of this mutual fund on a scale of 1.0 to 10.0.');
  lines.push('');
  lines.push(`Fund:   ${fund.name}`);
  lines.push(`Ticker: ${fund.ticker}`);
  lines.push('');

  // Notable facts — neutral framing, sentiment tag shown for context
  if (alerts.length) {
    lines.push('Notable facts (each may be positive, negative, or neutral — assess on its own merits):');
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
  lines.push('  - Each notable fact should be weighed independently — presence of a fact');
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
  lines.push('confidence guidance:');
  lines.push('  high   — well-known fund family, strong data, clear track record');
  lines.push('  medium — some knowledge gaps or ambiguous signals');
  lines.push('  low    — limited information, obscure fund, or highly uncertain situation');
  lines.push('');
  lines.push('Do not include any text outside the JSON object.');

  return lines.join('\n');
}

// — Score a single fund with retries —————————————————————————————————————
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
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
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

      // Persist to cache — non-fatal if it fails
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

  // Fallback — neutral score, never throws
  return {
    ticker:     fund.ticker,
    score:      MANAGER_FALLBACK.score,
    reasoning:  MANAGER_FALLBACK.reasoning,
    confidence: MANAGER_FALLBACK.confidence,
    fromCache:  false,
  };
}

// — Public entry point ————————————————————————————————————————————————————
// funds:       array of { ticker, name }
// expenseData: optional { [ticker]: { gross, net, note } } from expenses.js
//              pass null if expenses have not been fetched yet
export async function scoreManagers(funds, expenseData = null) {
  if (!funds?.length) return {};

  // Score all funds concurrently — cache hits return immediately
  const results = await Promise.all(
    funds.map(fund => scoreOneFund(fund, expenseData))
  );

  // Return as a map keyed by ticker
  const scores = {};
  results.forEach(r => { scores[r.ticker] = r; });
  return scores;
}
