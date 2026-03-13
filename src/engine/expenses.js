// FundLens v4 — Expense ratio engine
// Fetches gross/net expense ratio for a fund via Claude, classifies fund type
// from EDGAR holdings data, and returns a ±0.5 net-value modifier for use
// in scoring.js after the weighted composite sum.
//
// Architecture notes:
// - Fund type is derived programmatically from EDGAR holdings (assetCat
//   distribution + name pattern matching). Claude is NOT asked to classify it.
// - Claude is asked only for expense ratio (gross + net) with confidence flag.
// - Claude calls route through /api/claude (Railway proxy) — no Anthropic key
//   on the client. Same pattern as manager.js.
// - Cache: fund_profiles table, 90-day TTL (expense ratios change at most annually).
// - Fallback: modifier 0 (neutral) on any failure — never throws.
// - Benchmark vintage warning: emits console.warn if thresholds are ≥2 years
//   old, prompting a human to refresh EXPENSE_RATIO_THRESHOLDS in constants.js.

import { CLAUDE_MODEL, EXPENSE_BENCHMARKS_VINTAGE, EXPENSE_RATIO_THRESHOLDS, MONEY_MARKET_FUNDS } from './constants.js';
import { getFundProfile, setFundProfile } from '../services/cache.js';

// ── Benchmark vintage check ───────────────────────────────────────────────────
// Runs once on module load. Warns in Railway logs if ICI/Morningstar data is
// stale. Does not block execution — informational only.
const vintageAge = new Date().getFullYear() - EXPENSE_BENCHMARKS_VINTAGE;
if (vintageAge >= 2) {
  console.warn(
    `[expenses] Expense benchmarks are ${vintageAge} years old (vintage: ${EXPENSE_BENCHMARKS_VINTAGE}).` +
    ` Consider refreshing EXPENSE_RATIO_THRESHOLDS in constants.js from ICI/Morningstar.`
  );
}

// ── Fund type classification ──────────────────────────────────────────────────
// Derives fund type from EDGAR holdings assetCat distribution and fund name.
// Returns one of: 'indexEquity' | 'activeEquity' | 'indexBond' | 'activeBond'
//               | 'moneyMarket' | 'unknown'
//
// assetCat values from NPORT-P XML:
//   EC   — equity / common stock
//   DBT  — debt / bond
//   STIV — short-term investment vehicle (money market)
//   RF   — registered fund (fund-of-funds)
//
// Index detection: fund name contains 'index', '500', 'total market',
// 'russell', 'msci', 'ftse', 's&p', 'nasdaq', 'dow jones'.
export function classifyFundType(ticker, fundName, holdings) {
  // Money market: known set takes priority
  if (MONEY_MARKET_FUNDS.has(ticker)) return 'moneyMarket';

  // Tally assetCat counts
  const counts = { EC: 0, DBT: 0, STIV: 0, RF: 0, OTHER: 0 };
  for (const h of (holdings ?? [])) {
    const cat = (h.assetCat || '').toUpperCase();
    if (cat in counts) counts[cat]++;
    else counts.OTHER++;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return 'unknown';

  const pct = k => counts[k] / total;

  // Majority STIV → money market
  if (pct('STIV') > 0.5) return 'moneyMarket';

  // Majority DBT → bond fund
  if (pct('DBT') > 0.5) {
    return isIndexFund(fundName) ? 'indexBond' : 'activeBond';
  }

  // Majority EC (or mixed with RF) → equity fund
  if (pct('EC') > 0.3) {
    return isIndexFund(fundName) ? 'indexEquity' : 'activeEquity';
  }

  return 'unknown';
}

function isIndexFund(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return ['index', '500', 'total market', 'russell', 'msci', 'ftse',
          's&p', 'nasdaq', 'dow jones'].some(kw => n.includes(kw));
}

// ── Net-value modifier ────────────────────────────────────────────────────────
// Maps expense ratio to a ±0.5 modifier using the ICI/Morningstar thresholds
// for the fund's type. Linear interpolation within the average band.
//
//   ratio ≤ cheap                → +0.5 (well below average)
//   cheap < ratio < expensive    → linear +0.5 → -0.5
//   ratio ≥ expensive            → -0.5 (well above average)
//
// 'unknown' fund type → 0 (neutral; no penalty for unclassified funds)
export function calcExpenseModifier(expenseRatio, fundType) {
  if (expenseRatio == null || fundType === 'unknown') return 0;

  const thresholds = EXPENSE_RATIO_THRESHOLDS[fundType];
  if (!thresholds) return 0;

  const { cheap, expensive } = thresholds;

  if (expenseRatio <= cheap)     return  0.5;
  if (expenseRatio >= expensive) return -0.5;

  // Linear interpolation: cheap → +0.5, expensive → -0.5
  const t = (expenseRatio - cheap) / (expensive - cheap); // 0..1
  return Math.round((0.5 - t) * 100) / 100;
}

// ── Claude: expense ratio fetch ───────────────────────────────────────────────
// Calls /api/claude (Railway proxy — API key injected server-side).
// Returns { gross, net, note, confidence } or null on failure.
async function fetchExpenseFromClaude(ticker, fundName) {
  const prompt = `You are a mutual fund data assistant. Provide the current expense ratio for the following fund.

Fund ticker: ${ticker}
Fund name:   ${fundName}

Respond ONLY with a JSON object. No preamble, no markdown, no explanation.

{
  "gross": <number — gross expense ratio as a decimal, e.g. 0.0075 for 0.75%>,
  "net":   <number — net expense ratio after any fee waivers, same format. If no waiver, same as gross>,
  "note":  <string — one sentence max. Note any active fee waiver or unusual structure. Empty string if none.>,
  "confidence": <"high" | "medium" | "low">
}

confidence guide:
  high   — you have a specific, recent figure for this fund
  medium — you have a figure but it may be slightly dated or estimated
  low    — you are uncertain; the fund may have changed its fee structure recently`;

  try {
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 256,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data   = await res.json();
    const text   = (data.content || []).map(b => b.text || '').join('').trim();
    const clean  = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (typeof parsed.gross !== 'number' || typeof parsed.net !== 'number') {
      throw new Error('Missing gross or net in Claude response');
    }

    return {
      gross:      parsed.gross,
      net:        parsed.net,
      note:       parsed.note       ?? '',
      confidence: parsed.confidence ?? 'low',
    };
  } catch (err) {
    console.warn(`[expenses] Claude fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
// Returns:
// {
//   gross:      number | null,
//   net:        number | null,
//   note:       string,
//   fundType:   string,
//   modifier:   number,   ← ±0.5, applied by scoring.js after weighted sum
//   confidence: string,
//   fromCache:  boolean,
// }
//
// Never throws. On any failure, modifier is 0 (neutral).
export async function fetchExpenseData(ticker, fundName, holdings) {
  const fundType = classifyFundType(ticker, fundName, holdings);

  // Check Supabase cache (fund_profiles table, 90-day TTL enforced by getFundProfile)
  try {
    const cached = await getFundProfile(ticker);
    if (cached) {
      const modifier = calcExpenseModifier(cached.net ?? cached.gross, fundType);
      return {
        gross:      cached.gross      ?? null,
        net:        cached.net        ?? null,
        note:       cached.note       ?? '',
        fundType,
        modifier,
        confidence: cached.confidence ?? 'low',
        fromCache:  true,
      };
    }
  } catch (err) {
    console.warn(`[expenses] Cache read failed for ${ticker}:`, err.message);
  }

  // Fetch fresh from Claude
  const result = await fetchExpenseFromClaude(ticker, fundName);

  if (!result) {
    // Graceful fallback — neutral modifier, no penalty for data gaps
    return { gross: null, net: null, note: '', fundType, modifier: 0, confidence: 'low', fromCache: false };
  }

  const modifier = calcExpenseModifier(result.net ?? result.gross, fundType);

  // Persist to Supabase (fund_profiles table)
  try {
    await setFundProfile(ticker, {
      gross:      result.gross,
      net:        result.net,
      note:       result.note,
      confidence: result.confidence,
    });
  } catch (err) {
    console.warn(`[expenses] Cache write failed for ${ticker}:`, err.message);
    // Non-fatal — return data even if save fails
  }

  return {
    gross:      result.gross,
    net:        result.net,
    note:       result.note,
    fundType,
    modifier,
    confidence: result.confidence,
    fromCache:  false,
  };
}
