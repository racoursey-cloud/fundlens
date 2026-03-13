// FundLens v4 — Mandate scoring engine
// Asks Claude to score each fund's alignment with the current macro environment.
// Uses world data (FRED + Treasury yield curve + headlines) as context.
//
// Architecture notes:
// - Each fund gets its own Claude call — CONCURRENT via Promise.all.
// - 3 retries per fund. Failures are tolerated up to the coverage threshold.
// - Coverage threshold: 85% of funds must be successfully scored or the
//   pipeline aborts with an error. (Handoff doc said 70% — operator overrode to 85%.)
// - max_tokens: 2200 per call.
// - Treasury yield curve passed as raw numbers + computed spreads — NOT as a
//   label like "steep" or "inverted". Claude reasons from the actual shape.
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// !! QUANT CONTEXT — FLAGGED FOR OPERATOR APPROVAL BEFORE IMPLEMENTATION !!
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
//
// fundsWithQuantContext is currently null and intentionally not implemented.
//
// What it was intended to do:
//   Pass each fund's momentum score and risk-adjusted score INTO the mandate
//   prompt alongside holdings, so Claude can reason about whether market
//   behaviour (momentum) is CONFIRMING or CONTRADICTING the macro thesis.
//   Example: a fund with great macro fit but negative momentum is a weaker
//   buy than one where both signals agree. Claude could weight accordingly.
//
// Why it is not implemented yet:
//   Those scores (momentum, riskAdj) are computed by pipeline.js AFTER
//   mandate.js runs. The data does not exist at the time mandate.js is called.
//   Implementing this requires a TWO-PASS pipeline architecture:
//     Pass 1: tiingo.js computes momentum + riskAdj for all funds
//     Pass 2: mandate.js runs WITH quant context included
//   This changes the pipeline execution order and has implications for
//   performance, caching, and the pipeline step UI.
//
// DO NOT IMPLEMENT without explicit operator discussion and approval.
// Raise this when pipeline.js is being designed — that is the right moment.
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

import { CLAUDE_MODEL } from './constants.js';

const MANDATE_COVERAGE_THRESHOLD = 0.85; // 85% of funds must score successfully
const MANDATE_MAX_TOKENS = 2200;
const MANDATE_RETRIES = 3;
const MANDATE_TOP_HOLDINGS = 15; // top N holdings by weight passed to Claude
const MANDATE_TOP_HEADLINES = 10; // top N headlines from world data passed to Claude

// — Build the shared macro context block ————————————————————————————————
// This block is identical for every fund in the run — built once, reused.
function buildMacroContext(worldData) {
  const { fredData = {}, treasuryData = null, headlines = [] } = worldData;

  const lines = ['=== CURRENT MACRO ENVIRONMENT ===', ''];

  // FRED economic series
  lines.push('--- Economic Indicators (FRED) ---');
  for (const [seriesId, entry] of Object.entries(fredData)) {
    if (entry?.value !== undefined) {
      lines.push(`  ${entry.label}: ${entry.value} (as of ${entry.date})`);
    }
  }
  lines.push('');

  // Treasury yield curve — raw numbers + spreads, no labels like "steep/inverted"
  if (treasuryData) {
    lines.push('--- Treasury Yield Curve ---');
    lines.push(`  Date: ${treasuryData.date}`);
    lines.push(`  1Y: ${treasuryData.y1}%   2Y: ${treasuryData.y2}%   5Y: ${treasuryData.y5}%   10Y: ${treasuryData.y10}%   30Y: ${treasuryData.y30}%`);
    lines.push('');
    lines.push('  Computed spreads (percentage points):');
    const s = treasuryData.spreads;
    lines.push(`    Short end slope (2Y-1Y):    ${s.shortEnd >= 0 ? '+' : ''}${s.shortEnd}  [Fed near-term rate expectations]`);
    lines.push(`    Curve belly (5Y vs midpoint): ${s.belly   >= 0 ? '+' : ''}${s.belly}  [Mid-curve curvature — transition signal]`);
    lines.push(`    Classic spread (10Y-2Y):    ${s.classic >= 0 ? '+' : ''}${s.classic}  [Recession probability indicator]`);
    lines.push(`    Long end slope (30Y-10Y):   ${s.longEnd >= 0 ? '+' : ''}${s.longEnd}  [Long-term inflation expectations]`);
    lines.push('');
  } else {
    lines.push('--- Treasury Yield Curve ---');
    lines.push('  [Unavailable — Treasury data could not be fetched]');
    lines.push('');
  }

  // Top headlines
  if (headlines.length) {
    lines.push('--- Recent Financial Headlines ---');
    headlines.slice(0, MANDATE_TOP_HEADLINES).forEach((h, i) => {
      lines.push(`  ${i + 1}. [${h.source}] ${h.title}`);
    });
    lines.push('');
  }

  lines.push('=================================');
  return lines.join('\n');
}

// — Build the per-fund prompt ————————————————————————————————————————————
function buildFundPrompt(macroContext, fund) {
  const holdings = (fund.holdings || [])
    .slice(0, MANDATE_TOP_HOLDINGS)
    .map(h => `    ${h.weight?.toFixed(1) ?? '?'}%  ${h.ticker || 'N/A'}  ${h.name || ''}  [${h.sector || 'Unknown'}]`)
    .join('\n');

  return `${macroContext}

=== FUND TO SCORE ===
Name:   ${fund.name}
Ticker: ${fund.ticker}

Top holdings by weight:
${holdings || '  [No holdings data available]'}

=== YOUR TASK ===
Score this fund's MANDATE ALIGNMENT with the current macro environment above.

Mandate alignment means: given what is happening in the economy RIGHT NOW,
how well-positioned is this fund's investment strategy and sector exposures?

Consider:
- Which FRED indicators are signalling growth, stress, or transition?
- What is the yield curve's shape telling us about the direction of rates
  and the economy? (Use the raw numbers — do not just pattern-match on
  inversion/steepness labels.)
- Do the fund's top sector exposures benefit or face headwinds in this environment?
- Are the headlines consistent with or contradicting the FRED picture?

Respond ONLY with valid JSON in this exact format:
{
  "score": <number 1.0-10.0, one decimal place>,
  "reasoning": "<2-3 sentences explaining the score>"
}

Do not include any text outside the JSON object.
`;
}

// — Score a single fund with retries —————————————————————————————————————
async function scoreFund(macroContext, fund) {
  const prompt = buildFundPrompt(macroContext, fund);

  for (let attempt = 0; attempt <= MANDATE_RETRIES; attempt++) {
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: MANDATE_MAX_TOKENS,
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

      return {
        ticker:    fund.ticker,
        score:     Math.round(score * 10) / 10,
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      if (attempt < MANDATE_RETRIES) {
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      console.warn('mandate.js: scoring failed for', fund.ticker, 'after', MANDATE_RETRIES + 1, 'attempts:', err.message);
      return null;
    }
  }
  return null;
}

// — Public entry point ————————————————————————————————————————————————————
// funds: array of { ticker, name, holdings }
// worldData: { fredData, headlines, treasuryData } from world.js
//
// fundsWithQuantContext: null — NOT YET IMPLEMENTED.
// See the screaming warning at the top of this file before touching this.
export async function scoreMandates(funds, worldData, fundsWithQuantContext = null) {
  if (!funds?.length) return { scores: {}, coverage: 0, acceptable: false };

  const macroContext = buildMacroContext(worldData);

  // Score all funds concurrently — each gets its own Claude call
  const results = await Promise.all(
    funds.map(fund => scoreFund(macroContext, fund))
  );

  // Collect successes
  const scores = {};
  let successCount = 0;
  results.forEach(r => {
    if (r) {
      scores[r.ticker] = r;
      successCount++;
    }
  });

  const coverage = successCount / funds.length;
  const acceptable = coverage >= MANDATE_COVERAGE_THRESHOLD;

  if (!acceptable) {
    console.error(
      `mandate.js: coverage ${(coverage * 100).toFixed(0)}% below threshold ${(MANDATE_COVERAGE_THRESHOLD * 100).toFixed(0)}%`,
      `(${successCount}/${funds.length} funds scored)`
    );
  }

  return { scores, coverage, acceptable };
}
