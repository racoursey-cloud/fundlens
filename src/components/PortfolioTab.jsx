import { useState, useMemo, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore.js';
import { GICS_SECTORS, FACTOR_LABELS, DEFAULT_WEIGHTS } from '../engine/constants.js';

// ── Theme tokens ────────────────────────────────────────────────────────────
const T = {
  bg:        '#0e0f11',
  surface:   '#16181c',
  surfaceAlt:'#1c1e23',
  border:    '#25282e',
  text:      '#e2e4e9',
  textMuted: '#8b8f98',
  accent:    '#3b82f6',
  accentDim: 'rgba(59,130,246,0.15)',
};

const TIER_COLORS = {
  BREAKAWAY: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b', label: 'Breakaway' },
  STRONG:    { bg: 'rgba(34,197,94,0.15)',   text: '#22c55e', label: 'Strong'    },
  SOLID:     { bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6', label: 'Solid'     },
  NEUTRAL:   { bg: 'rgba(107,114,128,0.15)', text: '#6b7280', label: 'Neutral'   },
  WEAK:      { bg: 'rgba(239,68,68,0.15)',   text: '#ef4444', label: 'Weak'      },
  LOW_DATA:  { bg: 'rgba(107,114,128,0.15)', text: '#6b7280', label: 'Low Data'  },
};

// ── Donut chart helper ──────────────────────────────────────────────────────

function DonutChart({ slices, size = 200, innerRadius = 0.6, label, onSliceClick }) {
  const [hovered, setHovered] = useState(null);
  const r = size / 2;
  const ir = r * innerRadius;

  // Build arc paths
  const arcs = useMemo(() => {
    const result = [];
    let cumulative = 0;
    for (const s of slices) {
      const startAngle = cumulative * 2 * Math.PI;
      cumulative += s.pct / 100;
      const endAngle = cumulative * 2 * Math.PI;
      // SVG arc
      const x1 = r + r * 0.95 * Math.sin(startAngle);
      const y1 = r - r * 0.95 * Math.cos(startAngle);
      const x2 = r + r * 0.95 * Math.sin(endAngle);
      const y2 = r - r * 0.95 * Math.cos(endAngle);
      const ix1 = r + ir * Math.sin(endAngle);
      const iy1 = r - ir * Math.cos(endAngle);
      const ix2 = r + ir * Math.sin(startAngle);
      const iy2 = r - ir * Math.cos(startAngle);
      const large = s.pct > 50 ? 1 : 0;
      const d = [
        `M ${x1} ${y1}`,
        `A ${r * 0.95} ${r * 0.95} 0 ${large} 1 ${x2} ${y2}`,
        `L ${ix1} ${iy1}`,
        `A ${ir} ${ir} 0 ${large} 0 ${ix2} ${iy2}`,
        'Z',
      ].join(' ');
      result.push({ ...s, d, midAngle: (startAngle + endAngle) / 2 });
    }
    return result;
  }, [slices, r, ir]);

  const hoveredSlice = hovered !== null ? arcs[hovered] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      {label && (
        <div style={{ fontSize: 13, fontWeight: 600, color: T.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}
        </div>
      )}
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {arcs.map((arc, i) => (
            <path
              key={arc.id}
              d={arc.d}
              fill={arc.color}
              opacity={hovered === null || hovered === i ? 1 : 0.35}
              style={{ cursor: onSliceClick ? 'pointer' : 'default', transition: 'opacity 0.2s' }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => {
                if (onSliceClick) onSliceClick(arc);
                else console.log('Sector drill-down (deferred):', arc.id);
              }}
            />
          ))}
        </svg>
        {/* Center label */}
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center', pointerEvents: 'none',
        }}>
          {hoveredSlice ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, color: T.text }}>{hoveredSlice.pct.toFixed(1)}%</div>
              <div style={{ fontSize: 11, color: T.textMuted, maxWidth: size * 0.45, lineHeight: 1.3 }}>
                {hoveredSlice.label}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: T.textMuted }}>Hover for detail</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Legend ───────────────────────────────────────────────────────────────────

function Legend({ items }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', justifyContent: 'center' }}>
      {items.map(item => (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color, flexShrink: 0 }} />
          <span style={{ color: T.textMuted }}>{item.label}</span>
          <span style={{ color: T.text, fontWeight: 600 }}>{item.pct.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Weight slider ───────────────────────────────────────────────────────────

function WeightSlider({ factorKey, value, onChange }) {
  const info = FACTOR_LABELS[factorKey];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{info.label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.accent, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: T.accent }}
      />
      <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.3 }}>{info.desc}</div>
    </div>
  );
}

// ── Tier badge ──────────────────────────────────────────────────────────────

function TierBadge({ tier }) {
  const t = TIER_COLORS[tier] || TIER_COLORS.NEUTRAL;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.03em',
      background: t.bg,
      color: t.text,
    }}>
      {t.label}
    </span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function PortfolioTab() {
  const funds         = useAppStore(s => s.funds);
  const getWeights    = useAppStore(s => s.getWeights);
  const getRiskTol    = useAppStore(s => s.getRiskTolerance);
  const rescoreAction = useAppStore(s => s.rescoreWithWeights);

  const currentWeights = getWeights();
  const currentRisk    = getRiskTol();

  // Local slider state — initialized from store
  const [weights, setWeights] = useState({
    mandateScore:   currentWeights.mandateScore,
    momentum:       currentWeights.momentum,
    riskAdj:        currentWeights.riskAdj,
    managerQuality: currentWeights.managerQuality,
  });
  const [riskTolerance, setRiskTolerance] = useState(currentRisk);

  // Allocated funds only
  const allocatedFunds = useMemo(
    () => (funds || [])
      .filter(f => f.allocPct > 0)
      .sort((a, b) => b.allocPct - a.allocPct),
    [funds]
  );

  // ── Aggregate sector exposure (primary donut) ───────────────────────────
  const sectorSlices = useMemo(() => {
    const sectorAgg = {};
    for (const fund of allocatedFunds) {
      const holdingsArr = fund.holdings || [];
      for (const h of holdingsArr) {
        const sector = h.sector || 'Other';
        const contribution = (h.weight || 0) * (fund.allocPct / 100);
        sectorAgg[sector] = (sectorAgg[sector] || 0) + contribution;
      }
    }
    // Normalize to 100%
    const total = Object.values(sectorAgg).reduce((s, v) => s + v, 0);
    const slices = Object.entries(sectorAgg)
      .map(([name, raw]) => ({
        id:    name,
        label: name,
        pct:   total > 0 ? (raw / total) * 100 : 0,
        color: GICS_SECTORS[name]?.color || '#4b5563',
      }))
      .filter(s => s.pct > 0.1)
      .sort((a, b) => b.pct - a.pct);
    return slices;
  }, [allocatedFunds]);

  // ── Fund allocation slices (secondary donut) ────────────────────────────
  const FUND_PALETTE = [
    '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a78bfa',
    '#fb923c', '#84cc16',
  ];

  const fundSlices = useMemo(
    () => allocatedFunds.map((f, i) => ({
      id:    f.ticker,
      label: f.ticker,
      pct:   f.allocPct,
      color: FUND_PALETTE[i % FUND_PALETTE.length],
    })),
    [allocatedFunds]
  );

  // ── Slider change handler ───────────────────────────────────────────────
  const handleWeightChange = useCallback((key, val) => {
    const next = { ...weights, [key]: val };
    setWeights(next);
    rescoreAction(next);
  }, [weights, rescoreAction]);

  const handleRiskChange = useCallback((val) => {
    setRiskTolerance(val);
    // rescoreWithWeights doesn't accept risk separately — we need to update
    // userWeights.risk_tolerance in the store and rerun outlier. For now we
    // call the store's set directly through the existing rescore path.
    // Risk tolerance is read inside computeOutliersAndAllocation via getState().
    // We update the store's userWeights, then trigger a rescore with current weights.
    useAppStore.setState(prev => ({
      userWeights: { ...prev.userWeights, risk_tolerance: val },
    }));
    rescoreAction(weights);
  }, [weights, rescoreAction]);

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!funds?.length || allocatedFunds.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: 400, gap: 16, color: T.textMuted, textAlign: 'center', padding: 40,
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={T.textMuted} strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <div style={{ fontSize: 16, fontWeight: 600, color: T.text }}>No portfolio data yet</div>
        <div style={{ fontSize: 13, maxWidth: 320, lineHeight: 1.5 }}>
          Run the scoring pipeline to generate fund scores and allocation recommendations.
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, padding: '24px 0' }}>

      {/* ── Donuts row ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 24,
      }}>
        {/* Primary: Sector Exposure */}
        <div style={{
          background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
          padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        }}>
          {sectorSlices.length > 0 ? (
            <>
              <DonutChart
                slices={sectorSlices}
                size={220}
                label="Aggregate Sector Exposure"
                onSliceClick={(arc) => console.log('Sector drill-down (deferred):', arc.id, arc.pct.toFixed(1) + '%')}
              />
              <Legend items={sectorSlices} />
            </>
          ) : (
            <div style={{ color: T.textMuted, fontSize: 13, padding: 40, textAlign: 'center' }}>
              No holdings data available for sector breakdown.
            </div>
          )}
        </div>

        {/* Secondary: Fund Allocation */}
        <div style={{
          background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
          padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        }}>
          <DonutChart
            slices={fundSlices}
            size={220}
            label="Recommended Allocation"
          />
          <Legend items={fundSlices} />
        </div>
      </div>

      {/* ── Fund allocation table ──────────────────────────────────────── */}
      <div style={{
        background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
        overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Recommended Funds
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {['#', 'Ticker', 'Name', 'Score', 'Z-Score', 'Tier', 'Alloc %'].map(h => (
                  <th key={h} style={{
                    padding: '10px 16px', textAlign: h === 'Name' ? 'left' : 'center',
                    fontWeight: 600, color: T.textMuted, fontSize: 11,
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allocatedFunds.map((fund, i) => (
                <tr key={fund.ticker} style={{
                  borderBottom: i < allocatedFunds.length - 1 ? `1px solid ${T.border}` : 'none',
                  transition: 'background 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surfaceAlt}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '10px 16px', textAlign: 'center', color: T.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                    {i + 1}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: T.accent, fontFamily: 'monospace', letterSpacing: '0.02em' }}>
                    {fund.ticker}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'left', color: T.text, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fund.name}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
                    {fund.composite?.toFixed(1) ?? '—'}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'center', color: T.text, fontVariantNumeric: 'tabular-nums' }}>
                    {fund.zScore != null ? (fund.zScore >= 0 ? '+' : '') + fund.zScore.toFixed(2) : '—'}
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                    <TierBadge tier={fund.tier} />
                  </td>
                  <td style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: T.accent, fontVariantNumeric: 'tabular-nums' }}>
                    {fund.allocPct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Sliders: Weight + Risk Tolerance ───────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 24,
      }}>
        {/* Factor weight sliders */}
        <div style={{
          background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
          padding: 24, display: 'flex', flexDirection: 'column', gap: 20,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Factor Weights
          </div>
          {Object.keys(FACTOR_LABELS).map(key => (
            <WeightSlider
              key={key}
              factorKey={key}
              value={weights[key]}
              onChange={val => handleWeightChange(key, val)}
            />
          ))}
          <button
            onClick={() => {
              setWeights({ ...DEFAULT_WEIGHTS });
              rescoreAction({ ...DEFAULT_WEIGHTS });
            }}
            style={{
              marginTop: 4, padding: '8px 16px', borderRadius: 6,
              border: `1px solid ${T.border}`, background: 'transparent',
              color: T.textMuted, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; }}
          >
            Reset to Defaults
          </button>
        </div>

        {/* Risk tolerance slider */}
        <div style={{
          background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`,
          padding: 24, display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.textMuted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Risk Tolerance
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>Concentration Curve</span>
            <span style={{ fontSize: 24, fontWeight: 700, color: T.accent, fontVariantNumeric: 'tabular-nums' }}>{riskTolerance}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            value={riskTolerance}
            onChange={e => handleRiskChange(Number(e.target.value))}
            style={{ width: '100%', accentColor: T.accent }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.textMuted }}>
            <span>Conservative — spread evenly</span>
            <span>Aggressive — concentrate in leaders</span>
          </div>
          <div style={{
            marginTop: 8, padding: 16, borderRadius: 8,
            background: T.accentDim, fontSize: 12, lineHeight: 1.6, color: T.textMuted,
          }}>
            <strong style={{ color: T.text }}>How this works:</strong> Risk tolerance controls how
            aggressively allocation concentrates in top-scoring funds. At 1, qualifying funds
            get nearly equal weight. At 10, the highest-scoring funds dominate. Only funds
            above the median with sufficient data quality receive any allocation.
          </div>
        </div>
      </div>
    </div>
  );
}
