// =============================================================================
// FundLens v5.1 — src/components/portfolio/PortfolioTab.jsx
//
// Primary output view. Sections:
//   1. Allocation Recommendation — two SVG donut charts (sector + fund)
//   2. Fund Rankings Table — sorted by composite score
//   3. Scoring Controls — factor weight sliders + risk tolerance slider
//   4. Investor Letter — plain-English recommendation prose
//
// Reads from useAppStore only. No direct engine/API calls.
// All SVG — no charting library.
// =============================================================================

import { useMemo, useCallback } from 'react';
import useAppStore from '../../store/useAppStore.js';
import {
  GICS_SECTORS,
  FACTOR_LABELS,
  FACTOR_KEYS,
  getTierFromModZ,
} from '../../engine/constants.js';

// ---------------------------------------------------------------------------
// Donut geometry constants
// ---------------------------------------------------------------------------

const DR    = 70;                       // radius
const DCX   = 100;                      // center x
const DCY   = 100;                      // center y
const DSW   = 30;                       // stroke width (ring thickness)
const DCIRC = 2 * Math.PI * DR;        // ≈ 439.82

// ---------------------------------------------------------------------------
// Fund allocation colour palette (blues / greens / purples)
// ---------------------------------------------------------------------------

const FUND_PALETTE = [
  '#3b82f6', '#6366f1', '#8b5cf6', '#0ea5e9', '#10b981',
  '#14b8a6', '#a78bfa', '#34d399', '#60a5fa', '#818cf8',
  '#2dd4bf', '#4ade80', '#38bdf8', '#22d3ee', '#a3e635',
];

const fundColor = i => FUND_PALETTE[i % FUND_PALETTE.length];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a flat data array (each item has a .value) into SVG donut segments.
 * Returns the same array augmented with dashLen and offset for stroke-dasharray.
 */
function buildDonutSegments(data) {
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  if (total === 0) return [];

  let cumFraction = 0;
  return data.map(d => {
    const fraction = (d.value || 0) / total;
    const dashLen  = fraction * DCIRC;
    const offset   = -cumFraction * DCIRC;
    cumFraction   += fraction;
    return { ...d, dashLen, offset, fraction };
  });
}

/**
 * Aggregates sector exposure across allocated funds.
 * Returns [{ label, value (0–1), color }] sorted descending.
 *
 * v5.1: fund.allocation_pct is 0–1 decimal (e.g. 0.25 = 25%).
 * holdingsMap values may be { holdings: [...], meta } or a flat array.
 */
function computeSectorExposure(funds, holdingsMap) {
  const totals = {};
  let grand    = 0;

  for (const fund of funds) {
    if (!fund.allocation_pct || fund.allocation_pct <= 0) continue;

    // Safe access: holdingsMap entry may be { holdings, meta } or a flat array
    const raw      = holdingsMap[fund.ticker];
    const holdings = Array.isArray(raw) ? raw : (raw?.holdings || []);

    for (const h of holdings) {
      const sector = h.sector || h.gics_sector || h.sectorName;
      if (!sector) continue;
      const w = (h.weight || 0);                              // 0–100 scale
      const contribution = (w / 100) * fund.allocation_pct;   // both in fraction space
      totals[sector] = (totals[sector] || 0) + contribution;
      grand          += contribution;
    }
  }

  if (grand === 0) return [];

  return Object.entries(totals)
    .map(([sector, v]) => ({
      label: sector,
      value: v / grand,
      color: GICS_SECTORS[sector]?.color || '#6B7280',
    }))
    .sort((a, b) => b.value - a.value);
}

/** Maps risk tolerance 1–9 to a descriptive label. */
const riskLabel = v => {
  if (v <= 1) return 'Conservative';
  if (v <= 3) return 'Moderately Conservative';
  if (v <= 5) return 'Moderate';
  if (v <= 7) return 'Moderately Aggressive';
  return 'Aggressive';
};

/**
 * Parses **word** or **35%** patterns to <strong> elements.
 * Preserves newlines for prose formatting.
 */
function formatLetter(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: '#f1f5f9' }}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** SVG donut ring chart. `data` is [{label, value, color}]. */
function DonutChart({ data, centerLine1, centerLine2 }) {
  const segments = buildDonutSegments(data);

  return (
    <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true">
      {/* Rotate group so arc starts at 12 o'clock */}
      <g transform={`rotate(-90 ${DCX} ${DCY})`}>
        {/* Track */}
        <circle
          cx={DCX} cy={DCY} r={DR}
          fill="none"
          stroke="#25282e"
          strokeWidth={DSW}
        />
        {segments.length === 0 ? (
          /* Placeholder arc when no data */
          <circle
            cx={DCX} cy={DCY} r={DR}
            fill="none"
            stroke="#1c1e23"
            strokeWidth={DSW}
          />
        ) : segments.map((seg, i) => (
          <circle
            key={i}
            cx={DCX} cy={DCY} r={DR}
            fill="none"
            stroke={seg.color}
            strokeWidth={DSW}
            strokeDasharray={`${seg.dashLen} ${DCIRC}`}
            strokeDashoffset={seg.offset}
            strokeLinecap="butt"
          />
        ))}
      </g>

      {/* Center text — not rotated */}
      <text
        x="100" y="92"
        textAnchor="middle"
        fill={segments.length > 0 ? '#f1f5f9' : '#4b5563'}
        fontSize="28"
        fontWeight="700"
        fontFamily="Inter, sans-serif"
      >
        {centerLine1}
      </text>
      <text
        x="100" y="116"
        textAnchor="middle"
        fill="#6b7280"
        fontSize="11"
        fontFamily="Inter, sans-serif"
      >
        {centerLine2}
      </text>
    </svg>
  );
}

/**
 * Tier badge — coloured border + background, uppercase label.
 * v5.1: tier is a string ('BREAKAWAY', 'STRONG', etc.) or a modZ number.
 * We resolve it to { label, color } via getTierFromModZ from constants.js.
 */
function TierBadge({ tier }) {
  if (tier == null) return null;

  // Resolve string/number tier to { label, color } object
  const resolved = getTierFromModZ(tier);
  if (!resolved) return null;

  return (
    <span style={{
      display:       'inline-block',
      padding:       '2px 8px',
      borderRadius:  '4px',
      fontSize:      '10px',
      fontWeight:    '700',
      letterSpacing: '0.06em',
      color:         resolved.color,
      border:        `1px solid ${resolved.color}50`,
      background:    `${resolved.color}1a`,
      whiteSpace:    'nowrap',
    }}>
      {resolved.label}
    </span>
  );
}

/** 3-factor mini-bar strip used inside fund table rows. */
function FactorBars({ fund }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      {FACTOR_KEYS.map(key => {
        const score = fund[key] ?? 5;
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{
              width:        '66px',
              fontSize:     '9px',
              color:        '#6b7280',
              textAlign:    'right',
              fontFamily:   'Inter, sans-serif',
              flexShrink:   0,
            }}>
              {FACTOR_LABELS[key]}
            </span>
            <div style={{
              flex:         1,
              height:       '6px',
              background:   '#25282e',
              borderRadius: '3px',
              overflow:     'hidden',
              minWidth:     '60px',
            }}>
              <div style={{
                height:     '100%',
                width:      `${(score / 10) * 100}%`,
                background: '#3b82f6',
                borderRadius: '3px',
                transition: 'width 0.35s ease',
              }} />
            </div>
            <span style={{
              width:      '24px',
              fontSize:   '9px',
              color:      '#94a3b8',
              textAlign:  'right',
              fontFamily: 'JetBrains Mono, monospace',
              flexShrink: 0,
            }}>
              {score.toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider styles (injected once as a <style> tag)
// ---------------------------------------------------------------------------

const SLIDER_STYLE = `
  .fl-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    background: #25282e;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .fl-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #3b82f6;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
  }
  .fl-slider::-webkit-slider-thumb:hover {
    background: #60a5fa;
    transform: scale(1.15);
  }
  .fl-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: #3b82f6;
    cursor: pointer;
  }
`;

// ---------------------------------------------------------------------------
// PortfolioTab
// ---------------------------------------------------------------------------

export default function PortfolioTab() {
  const {
    funds,
    holdingsMap,
    investorLetter,
    weights,
    riskTolerance,
    source,
    isRunning,
    selectedFund,
    selectFund,
    runPipelineAction,
    rescoreLocal,
    setRiskTolerance,
  } = useAppStore();

  // ── Derived data ──────────────────────────────────────────────────────────

  const sectorData = useMemo(
    () => computeSectorExposure(funds, holdingsMap),
    [funds, holdingsMap]
  );

  const allocatedFunds = useMemo(
    () => funds.filter(f => f.allocation_pct > 0),
    [funds]
  );

  const fundDonutData = useMemo(
    () => allocatedFunds.map((f, i) => ({
      label: f.ticker,
      value: f.allocation_pct,
      color: fundColor(i),
    })),
    [allocatedFunds]
  );

  const sortedFunds = useMemo(
    () => [...funds].sort((a, b) => (b.composite ?? 5) - (a.composite ?? 5)),
    [funds]
  );

  const weightTotal = FACTOR_KEYS.reduce((s, k) => s + (weights[k] ?? 0), 0);

  // ── Weight slider handler ─────────────────────────────────────────────────

  const handleWeightChange = useCallback((key, rawValue) => {
    const val       = Math.max(0, Math.min(60, parseInt(rawValue, 10)));
    const others    = FACTOR_KEYS.filter(k => k !== key);
    const otherSum  = others.reduce((s, k) => s + (weights[k] ?? 0), 0);
    const remaining = 100 - val;

    let nw = { ...weights, [key]: val };

    if (otherSum === 0) {
      // Distribute remaining equally across the other keys
      const each = Math.floor(remaining / others.length);
      others.forEach(k => { nw[k] = each; });
      nw[others[0]] += remaining - each * others.length;  // absorb rounding to first
    } else {
      // Scale proportionally
      others.forEach(k => {
        nw[k] = Math.round(((weights[k] ?? 0) / otherSum) * remaining);
      });
      // Fix any rounding error on the largest other key
      const sum  = FACTOR_KEYS.reduce((s, k) => s + nw[k], 0);
      const diff = 100 - sum;
      if (diff !== 0) {
        const largest = others.reduce((a, b) => nw[a] >= nw[b] ? a : b);
        nw[largest]  += diff;
      }
    }

    rescoreLocal(nw);
  }, [weights, rescoreLocal]);

  // ── Empty state ───────────────────────────────────────────────────────────

  const isEmpty = source === 'seed' && !isRunning;

  if (isEmpty) {
    return (
      <div style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        height:         '64vh',
        gap:            '20px',
        fontFamily:     'Inter, sans-serif',
      }}>
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <circle cx="32" cy="32" r="30" stroke="#25282e" strokeWidth="4" />
          <path d="M32 14 L32 32 L44 44" stroke="#3b82f6" strokeWidth="3.5"
            strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="32" cy="32" r="3" fill="#3b82f6" />
        </svg>
        <p style={{ fontSize: '16px', color: '#6b7280', margin: 0, textAlign: 'center' }}>
          Run your first analysis to see recommendations
        </p>
        <button
          onClick={runPipelineAction}
          style={{
            padding:     '12px 36px',
            background:  '#3b82f6',
            color:       '#fff',
            border:      'none',
            borderRadius:'8px',
            fontSize:    '15px',
            fontWeight:  '600',
            cursor:      'pointer',
            fontFamily:  'Inter, sans-serif',
            transition:  'background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#2563eb'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#3b82f6'; }}
        >
          Run Analysis
        </button>
      </div>
    );
  }

  // ── Seed-source label for the factor bars column ──────────────────────────
  const isLive = source === 'live';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{SLIDER_STYLE}</style>

      <div style={{
        padding:    '24px',
        background: '#0e0f11',
        minHeight:  '100vh',
        fontFamily: 'Inter, sans-serif',
        color:      '#f1f5f9',
      }}>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 1 — ALLOCATION RECOMMENDATION (two donuts)
        ═══════════════════════════════════════════════════════════════════ */}
        <section style={{ marginBottom: '36px' }}>
          <h2 style={sectionHeading}>Allocation Recommendation</h2>

          <div style={{
            display:   'flex',
            gap:       '20px',
            flexWrap:  'wrap',
          }}>

            {/* ── Left donut: Sector Exposure ── */}
            <div style={card}>
              <div style={cardLabel}>Sector Exposure</div>
              <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flexShrink: 0 }}>
                  <DonutChart
                    data={sectorData}
                    centerLine1={sectorData.length > 0 ? sectorData.length : '\u2014'}
                    centerLine2={sectorData.length === 1 ? 'sector' : 'sectors'}
                  />
                </div>
                <div style={{ flex: 1, minWidth: '110px', paddingTop: '12px' }}>
                  {sectorData.length === 0 ? (
                    <p style={{ fontSize: '12px', color: '#4b5563', margin: 0 }}>
                      No holdings data yet
                    </p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                      {sectorData.map(s => (
                        <div key={s.label}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{
                            width: '8px', height: '8px', borderRadius: '50%',
                            background: s.color, flexShrink: 0,
                          }} />
                          <span style={{ fontSize: '12px', color: '#94a3b8', flex: 1,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.label}
                          </span>
                          <span style={{
                            fontSize: '12px', fontWeight: '600', color: '#f1f5f9',
                            fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
                          }}>
                            {(s.value * 100).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Right donut: Fund Allocation ── */}
            <div style={card}>
              <div style={cardLabel}>Fund Allocation</div>
              <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flexShrink: 0 }}>
                  <DonutChart
                    data={fundDonutData}
                    centerLine1={allocatedFunds.length > 0 ? allocatedFunds.length : '0'}
                    centerLine2={allocatedFunds.length === 1 ? 'fund' : 'funds'}
                  />
                </div>
                <div style={{ flex: 1, minWidth: '110px', paddingTop: '12px' }}>
                  {allocatedFunds.length === 0 ? (
                    <p style={{ fontSize: '12px', color: '#4b5563', margin: 0 }}>
                      No funds allocated yet
                    </p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                      {allocatedFunds.map((f, i) => (
                        <div
                          key={f.ticker}
                          onClick={() => selectFund(f.ticker)}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px',
                            cursor: 'pointer' }}
                        >
                          <div style={{
                            width: '8px', height: '8px', borderRadius: '50%',
                            background: fundColor(i), flexShrink: 0,
                          }} />
                          <span style={{
                            fontSize: '11px', color: '#3b82f6', flex: 1,
                            fontFamily: 'JetBrains Mono, monospace', fontWeight: '600',
                          }}>
                            {f.ticker}
                          </span>
                          <span style={{
                            fontSize: '12px', fontWeight: '600', color: '#f1f5f9',
                            fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
                          }}>
                            {(f.allocation_pct * 100).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 2 — FUND ALLOCATION TABLE
        ═══════════════════════════════════════════════════════════════════ */}
        <section style={{ marginBottom: '36px' }}>
          <h2 style={sectionHeading}>Fund Rankings</h2>

          <div style={{
            background:   '#16181c',
            border:       '1px solid #25282e',
            borderRadius: '12px',
            overflow:     'hidden',
          }}>
            {/* Table header */}
            <div style={{
              display:       'grid',
              gridTemplateColumns: TABLE_COLS,
              padding:       '10px 16px',
              borderBottom:  '1px solid #25282e',
              fontSize:      '9px',
              fontWeight:    '700',
              color:         '#4b5563',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              <span>#</span>
              <span>Ticker</span>
              <span>Name</span>
              <span style={{ textAlign: 'right' }}>Score</span>
              <span style={{ textAlign: 'center' }}>Tier</span>
              <span style={{ textAlign: 'right' }}>Alloc</span>
              <span style={{ paddingLeft: '8px' }}>Factors</span>
            </div>

            {sortedFunds.map((fund, idx) => {
              const isSel    = selectedFund === fund.ticker;
              const hasAlloc = fund.allocation_pct > 0;
              const showBars = isLive && !fund.isMoneyMarket;

              return (
                <div
                  key={fund.ticker}
                  onClick={() => selectFund(isSel ? null : fund.ticker)}
                  style={{
                    display:       'grid',
                    gridTemplateColumns: TABLE_COLS,
                    padding:       '10px 16px',
                    borderBottom:  idx < sortedFunds.length - 1
                      ? '1px solid #1a1d22' : 'none',
                    borderLeft:    isSel ? '3px solid #3b82f6' : '3px solid transparent',
                    background:    isSel ? '#1c1e23' : 'transparent',
                    cursor:        'pointer',
                    alignItems:    'center',
                    transition:    'background 0.12s',
                  }}
                  onMouseEnter={e => {
                    if (!isSel) e.currentTarget.style.background = '#1c1e23';
                  }}
                  onMouseLeave={e => {
                    if (!isSel) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {/* Rank */}
                  <span style={{
                    fontSize:   '11px',
                    color:      '#4b5563',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {idx + 1}
                  </span>

                  {/* Ticker */}
                  <span style={{
                    fontSize:   '12px',
                    fontWeight: '700',
                    color:      '#3b82f6',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {fund.ticker}
                  </span>

                  {/* Name */}
                  <span style={{
                    fontSize:     '12px',
                    color:        '#94a3b8',
                    overflow:     'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace:   'nowrap',
                    paddingRight: '8px',
                  }}>
                    {fund.name}
                  </span>

                  {/* Composite */}
                  <span style={{
                    fontSize:   '14px',
                    fontWeight: '700',
                    color:      '#f1f5f9',
                    textAlign:  'right',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {(fund.composite ?? 5).toFixed(1)}
                  </span>

                  {/* Tier badge */}
                  <div style={{ textAlign: 'center' }}>
                    <TierBadge tier={fund.tier} />
                  </div>

                  {/* Alloc % — v5.1: allocation_pct is 0–1 decimal */}
                  <span style={{
                    fontSize:   '13px',
                    fontWeight: hasAlloc ? '700' : '400',
                    color:      hasAlloc ? '#f1f5f9' : '#374151',
                    textAlign:  'right',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {hasAlloc ? `${(fund.allocation_pct * 100).toFixed(1)}%` : '\u2014'}
                  </span>

                  {/* Factor bars */}
                  <div style={{ paddingLeft: '8px' }}>
                    {showBars ? (
                      <FactorBars fund={fund} />
                    ) : (
                      <span style={{ fontSize: '11px', color: '#374151' }}>\u2014</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 3 — SCORING CONTROLS (sliders)
        ═══════════════════════════════════════════════════════════════════ */}
        <section style={{ marginBottom: '36px' }}>
          <h2 style={sectionHeading}>Scoring Controls</h2>

          <div style={{
            display:               'grid',
            gridTemplateColumns:   'repeat(auto-fit, minmax(290px, 1fr))',
            gap:                   '20px',
          }}>

            {/* ── Factor Weight Sliders ── */}
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: '20px' }}>
                <div style={cardLabel}>Factor Weights</div>
                <span style={{
                  fontSize:   '11px',
                  fontWeight: '700',
                  color:      weightTotal === 100 ? '#10b981' : '#ef4444',
                  fontFamily: 'JetBrains Mono, monospace',
                }}>
                  Total: {weightTotal}%
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                {FACTOR_KEYS.map(key => (
                  <div key={key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between',
                      marginBottom: '8px', alignItems: 'baseline' }}>
                      <label style={{ fontSize: '12px', color: '#94a3b8' }}>
                        {FACTOR_LABELS[key]}
                      </label>
                      <span style={{
                        fontSize:   '13px',
                        fontWeight: '700',
                        color:      '#f1f5f9',
                        fontFamily: 'JetBrains Mono, monospace',
                      }}>
                        {weights[key] ?? 0}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="60"
                      step="1"
                      value={weights[key] ?? 0}
                      onChange={e => handleWeightChange(key, e.target.value)}
                      className="fl-slider"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ── Risk Tolerance Slider ── */}
            <div style={card}>
              <div style={cardLabel}>Risk Tolerance</div>

              <div style={{ marginTop: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between',
                  marginBottom: '8px', alignItems: 'baseline' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>
                    {riskLabel(riskTolerance)}
                  </label>
                  <span style={{
                    fontSize:   '13px',
                    fontWeight: '700',
                    color:      '#f1f5f9',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {riskTolerance} / 9
                  </span>
                </div>

                <input
                  type="range"
                  min="1"
                  max="9"
                  step="1"
                  value={riskTolerance}
                  onChange={e => setRiskTolerance(parseInt(e.target.value, 10))}
                  className="fl-slider"
                />

                <div style={{ display: 'flex', justifyContent: 'space-between',
                  marginTop: '6px' }}>
                  <span style={{ fontSize: '10px', color: '#4b5563' }}>Conservative</span>
                  <span style={{ fontSize: '10px', color: '#4b5563' }}>Aggressive</span>
                </div>
              </div>

              {/* Risk context blurb */}
              <div style={{
                marginTop:    '20px',
                padding:      '14px',
                background:   '#0e0f11',
                borderRadius: '8px',
                border:       '1px solid #25282e',
                fontSize:     '12px',
                color:        '#6b7280',
                lineHeight:   '1.65',
              }}>
                {riskTolerance <= 3
                  ? 'Allocation spreads evenly across qualifying funds. Lower concentration, smoother return profile.'
                  : riskTolerance <= 6
                  ? 'Balanced mix: top-scoring funds receive more weight without extreme concentration.'
                  : 'Allocation tilts sharply toward the highest-scoring funds. Greater upside potential, higher variance.'}
              </div>

              {/* Allocation curve visualisation — simple 9-step bar */}
              <div style={{ marginTop: '16px' }}>
                <div style={{ fontSize: '10px', color: '#4b5563', marginBottom: '6px' }}>
                  Allocation curve shape
                </div>
                <div style={{ display: 'flex', gap: '3px', alignItems: 'flex-end', height: '28px' }}>
                  {Array.from({ length: 9 }, (_, i) => {
                    const k      = 0.1 + (riskTolerance * 0.20);
                    const score  = 9 - i;  // highest score first
                    const raw    = Math.exp(k * score);
                    const maxRaw = Math.exp(k * 9);
                    const h      = Math.max(4, Math.round((raw / maxRaw) * 28));
                    return (
                      <div
                        key={i}
                        style={{
                          flex:         1,
                          height:       `${h}px`,
                          background:   i < 3 ? '#3b82f6' : '#25282e',
                          borderRadius: '2px',
                          transition:   'height 0.25s ease',
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* ══════════════════════════════════════════════════════════════════
            SECTION 4 — INVESTOR LETTER
        ═══════════════════════════════════════════════════════════════════ */}
        {investorLetter && (
          <section style={{ marginBottom: '24px' }}>
            <h2 style={sectionHeading}>Your Investment Recommendation</h2>

            <div style={card}>
              {/* Decorative left accent bar */}
              <div style={{
                display:       'flex',
                gap:           '20px',
                alignItems:    'flex-start',
              }}>
                <div style={{
                  width:        '3px',
                  alignSelf:    'stretch',
                  background:   'linear-gradient(180deg, #3b82f6 0%, #6366f1 100%)',
                  borderRadius: '2px',
                  flexShrink:   0,
                }} />
                <div style={{
                  fontSize:   '14px',
                  lineHeight: '1.9',
                  color:      '#cbd5e1',
                  fontFamily: 'Inter, sans-serif',
                  whiteSpace: 'pre-wrap',
                  flex:       1,
                }}>
                  {formatLetter(investorLetter)}
                </div>
              </div>
            </div>
          </section>
        )}

      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared style objects (defined outside component to avoid per-render alloc)
// ---------------------------------------------------------------------------

const TABLE_COLS = '36px 80px 1fr 64px 100px 64px minmax(160px, 200px)';

const sectionHeading = {
  fontSize:      '11px',
  fontWeight:    '700',
  color:         '#6b7280',
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  marginBottom:  '16px',
  margin:        '0 0 16px 0',
};

const card = {
  flex:         '1',
  minWidth:     '280px',
  background:   '#16181c',
  border:       '1px solid #25282e',
  borderRadius: '12px',
  padding:      '22px 24px',
};

const cardLabel = {
  fontSize:      '11px',
  fontWeight:    '700',
  color:         '#6b7280',
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  marginBottom:  '0',
};
