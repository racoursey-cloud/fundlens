// FundLens v4 — Expense ratio fetcher
// Fetches gross/net expense ratios for each fund via Claude's training knowledge.
// No web_search — explicitly prohibited by architecture constraints.
// 90-day Supabase cache — expense ratios change slowly (quarterly at most).
//
// Architecture notes:
// - Fund type is derived PROGRAMMATICALLY from EDGAR holdings assetCat distribution
//   and fund name patterns — Claude is NOT asked to classify fund type.
//   This keeps classification deterministic and auditable.
// - Claude is only asked for the expense ratio numbers and confidence level.
// - EXPENSE_THRESHOLDS is exported so scoring.js can apply the net-value
//   modifier (±0.5 points on composite score) without reimporting this file.
// - Thresholds are anchored to ICI/Morningstar 2024 published data for
//   401(k) plan participants — NOT generic industry averages.
//   Sources: ICI "Economics of Providing 401(k) Plans 2024" (July 2025)
//            Morningstar "US Fund Fee Study 2024" (May 2025)
// - expenses.js never throws — fallback values always returned.

import { CLAUDE_MODEL, MONEY_MARKET_FUNDS } from './constants.js';
import { getFundProfile, setFundProfile } from '../services/cache.js';

const EXPENSE_RETRIES  = 3;
const EXPENSE_MAX_TOKENS = 800;

// — ICI/Morningstar 2024 expense ratio thresholds by fund type —————————————
// cheap:     at or below this is genuinely cheap for this category
// expensive: at or above this warrants a penalty
// These are 401(k) participant asset-weighted averages with percentile context.
// scoring.js imports this to compute the ±0.5 composite score modifier.
export const EXPENSE_THRESHOLDS = {
  equity: {
    passive: { cheap: 0.10, average: 0.20, expensive: 0.30 },  // index equity 401k avg ~0.11%
    active:  { cheap: 0.40, average: 0.60, expensive: 0.80 },  // active equity 401k avg ~0.26-0.60%
  },
  bond: {
    passive: { cheap: 0.15, average: 0.25, expensive: 0.40 },  // index bond avg ~0.11-0.15%
    active:  { cheap: 0.30, average: 0.55, expensive: 0.70 },  // active bond 401k avg ~0.38%
  },
  hybrid: {
    passive: { cheap: 0.15, average: 0.30, expensive: 0.45 },
    active:  { cheap: 0.35, average: 0.55, expensive: 0.75 },  // target date avg ~0.29%
  },
  moneyMarket: {
    passive: { cheap: 0.10, average: 0.22, expensive: 0.40 },  // money market avg 0.22% (2024)
    active:  { cheap: 0.10, average: 0.22, expensive: 0.40 },  // same — no meaningful passive/active split
  },
};

// — Derive fund type from holdings + name ————————————————————————————————
// Pure function — no API calls. Uses EDGAR assetCat distribution and name patterns.
// assetCat values from NPORT-P XML: EC (equity), DBT (debt/bond),
// RF (registered fund), STIV (short-term/money market), other
export function deriveFundType(fund, holdings = []) {
  // Money market funds — known set, skip analysis
  if (MONEY_MARKET_FUNDS.has(fund.ticker)) {
    return { category: 'moneyMarket', passive: false };
  }

  // Passive detection from fund name
  const nameLower = (fund.name || '').toLowerCase();
  const passive = /index|s&p|500|total market|russell|nasdaq|dow jones|wilshire|msci|ftse/i.test(nameLower);

  // assetCat distribution from holdings
  const counts = { EC: 0, DBT: 0, STIV: 0, RF: 0, OTHER: 0 };
  holdings.forEach(h => {
    const cat = (h.assetCat || '').toUpperCase();
    if (cat === 'EC')   counts.EC++;
    else if (cat === 'DBT')  counts.DBT++;
    else if (cat === 'STIV') counts.STIV++;
    else if (cat === 'RF')   counts.RF++;
    else                     counts.OTHER++;
  });

  const total = holdings.length || 1;
  const ecPct   = counts.EC   / total;
  const dbtPct  = counts.DBT  / total;
  const stivPct = counts.STIV / total;

  // Classify by dominant asset category
  let category;
  if (stivPct > 0.80)       category = 'moneyMarket';
  else if (ecPct  > 0.60)   category = 'equity';
  else if (dbtPct > 0.60)   category = 'bond';
  else                      category = 'hybrid';

  // Bond name signals override if holdings are sparse
  if (!holdings.length) {
    if (/bond|income|fixed|treasury|credit|yield|debt/i.test(nameLower)) category = 'bond';
    else if (/balanced|allocation|blend|multi/i.test(nameLower))          category = 'hybrid';
    else                                                                   category = 'equity';
  }

  return { category, passive };
}

// — Build Claude prompt ———————————————————————————————————————————————————
function buildExpensePrompt(fund) {
  return `What is the expense ratio for this mutual fund?

Fund:   ${fund.name}
Ticker: ${fund.ticker}

Provide the most recent gross and net expense ratios you have knowledge of.
Net expense ratio is what investors actually pay after any fee waivers.
If gross and net are the same (no waiver), set both to the same value.

If there is a fee waiver or unusual situation, describe it briefly in the note field.

Respond ONLY with valid JSON in this exact format:
{
  "gross": <percentage as decimal, e.g. 0.015 for 0.015%>,
  "net": <percentage as decimal>,
  "note": "<brief note about waiver or situation, or null if none>",
  "confidence": "<high | medium | low>"
}

confidence guidance:
  high   — well-known fund, recently verified expense ratio
  medium — reasonably confident but data may be slightly dated
  low    — limited information or uncertain

Do not include any text outside the JSON object.`;
}

// — Score one fund with cache + retries ——————————————————————————————————
async function scoreOneExpense(fund, holdings) {
  // Derive fund type programmatically — no API call needed
  const fundType = deriveFundType(fund, holdings);

  // Check 90-day cache
  try {
    const cached = await getFundProfile(fund.ticker);
    if (cached) {
      return {
        ticker:     fund.ticker,
        gross:      cached.gross      ?? null,
        net:        cached.net        ?? null,
        note:       cached.note       ?? null,
        confidence: cached.confidence ?? 'medium',
        fundType:   cached.fund_type  ? JSON.parse(cached.fund_type) : fundType,
        fromCache:  true,
      };
    }
  } catch (err) {
    console.warn('expenses.js: cache read failed for', fund.ticker, err.message);
  }

  // Call Claude for expense ratio
  const prompt = buildExpensePrompt(fund);
  let gross = null, net = null, note = null, confidence = 'low';

  for (let attempt = 0; attempt <= EXPENSE_RETRIES; attempt++) {
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: EXPENSE_MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error('Claude API ' + res.status);

      const data = await res.json();
      const text = (data.content || []).map(b => b.text || '').join('').trim();
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      gross = typeof parsed.gross === 'number' ? parsed.gross : null;
      net   = typeof parsed.net   === 'number' ? parsed.net   : gross;

      const validConf = ['high', 'medium', 'low'];
      confidence = validConf.includes(parsed.confidence) ? parsed.confidence : 'medium';
      note = parsed.note || null;
      break;

    } catch (err) {
      if (attempt < EXPENSE_RETRIES) {
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      console.warn('expenses.js: Claude failed for', fund.ticker, 'after', EXPENSE_RETRIES + 1, 'attempts:', err.message);
    }
  }

  const result = {
    ticker: fund.ticker,
    gross,
    net,
    note,
    confidence,
    fundType,
    fromCache: false,
  };

  // Persist to cache — non-fatal if it fails
  try {
    await setFundProfile(fund.ticker, {
      gross,
      net,
      note,
      confidence,
      fund_type: JSON.stringify(fundType),
    });
  } catch (err) {
    console.warn('expenses.js: cache write failed for', fund.ticker, err.message);
  }

  return result;
}

// — Public entry point ————————————————————————————————————————————————————
// funds:       array of { ticker, name }
// holdingsMap: { [ticker]: holdings[] } — from EDGAR, already fetched by pipeline
//              pass {} if holdings not yet available — fund type falls back to name analysis
export async function fetchExpenses(funds, holdingsMap = {}) {
  if (!funds?.length) return {};

  // Run all funds concurrently — cache hits return immediately
  const results = await Promise.all(
    funds.map(fund => scoreOneExpense(fund, holdingsMap[fund.ticker] ?? []))
  );

  // Return as map keyed by ticker
  const expenses = {};
  results.forEach(r => { expenses[r.ticker] = r; });
  return expenses;
}
