// =============================================================================
// FundLens v5 — src/components/shared/FundDetailSidebar.jsx
// Slide-in panel (right → 0) showing full detail for selectedFund.
// Sections: composite + factor bars · sector donut · mandate + manager reasoning.
// =============================================================================

import { useState, useEffect, useMemo } from 'react';
import useAppStore from '../../store/useAppStore';
import {
  GICS_SECTORS,
  FACTOR_LABELS,
  FACTOR_KEYS,
  getTierFromModZ,
} from '../../engine/constants';

// ---------------------------------------------------------------------------
// SVG donut math
// ---------------------------------------------------------------------------
function toRad(deg) {
  return ((deg - 90) * Math.PI) / 180;
}

function polarXY(cx, cy, r, deg) {
  const a = toRad(deg);
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/**
 * Returns an SVG path string for a donut slice.
 * A tiny gap is applied to visually separate adjacent slices.
 */
function slicePath(cx, cy, outerR, innerR, startDeg, endDeg) {
  const span = endDeg - startDeg;
  if (span < 0.1) return '';

  // Leave a 0.8° gap between slices
  const gap = span > 2 ? 0.4 : 0;
  const s = startDeg + gap;
  const e = endDeg - gap;
  if (e <= s) return '';

  const large = e - s > 180 ? 1 : 0;
  const o1 = polarXY(cx, cy, outerR, s);
  const o2 = polarXY(cx, cy, outerR, e);
  const i1 = polarXY(cx, cy, innerR, e);
  const i2 = polarXY(cx, cy, innerR, s);

  const f = n => n.toFixed(3);
  return [
    `M ${f(o1.x)} ${f(o1.y)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${f(o2.x)} ${f(o2.y)}`,
    `L ${f(i1.x)} ${f(i1.y)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${f(i2.x)} ${f(i2.y)}`,
    'Z',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TierBadge({ tier }) {
  if (!tier) return null;
  const { label, color } = tier;
  return (
    <span
      style={{
        display: 'inline-block',
        background: color + '22',
        color,
        border: `1px solid ${color}55`,
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {label}
    </span>
  );
}

function FactorBar({ label, score }) {
  const pct = Math.min(100, Math.max(0, ((score ?? 5.0) / 10) * 100));
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 4,
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{label}</span>
        <span
          style={{
            fontSize: 12,
            fontFamily: 'JetBrains Mono, monospace',
            color: '#e2e8f0',
          }}
        >
          {(score ?? 5.0).toFixed(1)}
        </span>
      </div>
      <div
        style={{
          height: 6,
          background: '#25282e',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: '#3b82f6',
            width: `${pct}%`,
            transition: 'width 400ms ease',
          }}
        />
      </div>
    </div>
  );
}

function ReasoningBlock({ title, text }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: '#6b7280',
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 13,
          color: text ? '#d1d5db' : '#4b5563',
          lineHeight: 1.65,
          fontStyle: text ? 'normal' : 'italic',
        }}
      >
        {text ?? 'Reasoning not available'}
      </div>
    </div>
  );
}

function PanelDivider() {
  return <div style={{ height: 1, background: '#25282e', margin: '4px 0 24px' }} />;
}

// ---------------------------------------------------------------------------
// Sector Donut
// ---------------------------------------------------------------------------
function SectorDonut({ holdings, activeSector, onSectorClick }) {
  // Group holdings by sector, sum weights
  const sectorMap = useMemo(() => {
    const map = {};
    for (const h of holdings) {
      const sector = h.sector || 'Other';
      if (!map[sector]) map[sector] = { weight: 0, items: [] };
      map[sector].weight += h.weight ?? 0;
      map[sector].items.push(h);
    }
    return map;
  }, [holdings]);

  const sectors = useMemo(() => {
    return Object.entries(sectorMap)
      .map(([name, data]) => ({
        name,
        weight: data.weight,
        items: data.items.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
        color: GICS_SECTORS[name]?.color ?? '#6b7280',
      }))
      .sort((a, b) => b.weight - a.weight);
  }, [sectorMap]);

  const totalWeight = sectors.reduce((s, sec) => s + sec.weight, 0);

  // Build slices
  const cx = 110, cy = 105, outerR = 82, innerR = 56;
  let cursor = 0;
  const slices = sectors.map(sec => {
    const pct  = totalWeight > 0 ? sec.weight / totalWeight : 0;
    const span = pct * 360;
    const path = slicePath(cx, cy, outerR, innerR, cursor, cursor + span);
    const midDeg = cursor + span / 2;
    const labelPt = polarXY(cx, cy, outerR + 14, midDeg);
    const result   = { ...sec, pct, path, midDeg, labelPt };
    cursor += span;
    return result;
  });

  if (sectors.length === 0) return null;

  return (
    <div>
      {/* SVG */}
      <svg
        width={220}
        height={210}
        viewBox="0 0 220 210"
        style={{ display: 'block', margin: '0 auto' }}
      >
        {slices.map(slice => (
          <path
            key={slice.name}
            d={slice.path}
            fill={slice.color}
            opacity={activeSector && activeSector !== slice.name ? 0.25 : 1}
            style={{ cursor: 'pointer', transition: 'opacity 150ms' }}
            onClick={() => onSectorClick(slice.name)}
          />
        ))}
        {/* Centre label */}
        <text
          x={cx}
          y={cy - 6}
          textAnchor="middle"
          style={{ fill: '#9ca3af', fontSize: 10, fontFamily: 'Inter, sans-serif' }}
        >
          Sector
        </text>
        <text
          x={cx}
          y={cy + 12}
          textAnchor="middle"
          style={{ fill: '#e2e8f0', fontSize: 12, fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
        >
          Exposure
        </text>
      </svg>

      {/* Legend + expandable holdings */}
      <div style={{ marginTop: 8 }}>
        {slices.map(slice => (
          <div key={slice.name}>
            {/* Legend row */}
            <div
              onClick={() => onSectorClick(slice.name)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 4px',
                cursor: 'pointer',
                borderRadius: 4,
                opacity: activeSector && activeSector !== slice.name ? 0.4 : 1,
                transition: 'opacity 150ms, background 100ms',
                background: activeSector === slice.name ? '#1c1e23' : 'transparent',
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: slice.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 13, color: '#e2e8f0', flex: 1 }}>
                {slice.name}
              </span>
              <span
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 12,
                  color: '#9ca3af',
                }}
              >
                {(slice.pct * 100).toFixed(1)}%
              </span>
              <span style={{ fontSize: 11, color: '#4b5563', marginLeft: 2 }}>
                {activeSector === slice.name ? '▾' : '▸'}
              </span>
            </div>

            {/* Expanded holdings list */}
            {activeSector === slice.name && (
              <div
                style={{
                  marginLeft: 18,
                  marginBottom: 6,
                  borderLeft: `2px solid ${slice.color}55`,
                  paddingLeft: 10,
                }}
              >
                {slice.items.map((h, idx) => {
                  const name   = h.holding_name   ?? h.name   ?? '—';
                  const ticker = h.holding_ticker  ?? h.ticker ?? null;
                  const wt     = h.weight != null ? `${Number(h.weight).toFixed(2)}%` : '—';
                  return (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '4px 0',
                        fontSize: 12,
                        borderBottom:
                          idx < slice.items.length - 1
                            ? '1px solid #1c1e23'
                            : 'none',
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          color: '#cbd5e1',
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </span>
                      {ticker && (
                        <span
                          style={{
                            fontFamily: 'JetBrains Mono, monospace',
                            color: '#6b7280',
                            fontSize: 11,
                            flexShrink: 0,
                          }}
                        >
                          {ticker}
                        </span>
                      )}
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          color: '#9ca3af',
                          fontSize: 11,
                          flexShrink: 0,
                        }}
                      >
                        {wt}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function FundDetailSidebar() {
  const {
    selectedFund,
    funds,
    holdingsMap,
    mandateScores,
    managerScores,
    selectFund,
  } = useAppStore();

  const [activeSector, setActiveSector] = useState(null);

  // Reset expanded sector whenever the selected fund changes
  useEffect(() => {
    setActiveSector(null);
  }, [selectedFund]);

  if (!selectedFund) return null;

  const fund = funds.find(f => f.ticker === selectedFund);
  if (!fund) return null;

  const holdings = holdingsMap[selectedFund] ?? [];

  const tier = fund.tier ?? getTierFromModZ(fund.modZ ?? 0);

  const modZDisplay = (() => {
    if (fund.modZ == null) return '—';
    const z = Number(fund.modZ);
    return (z >= 0 ? '+' : '') + z.toFixed(2);
  })();

  const allocDisplay =
    fund.allocPct > 0
      ? `${(fund.allocPct * 100).toFixed(1)}% allocation`
      : 'Not allocated';

  const mandateReasoning = mandateScores?.[selectedFund]?.reasoning ?? null;
  const managerReasoning = managerScores?.[selectedFund]?.reasoning  ?? null;

  const hasPenalty  = fund.concentrationPenalty != null && fund.concentrationPenalty !== 0;
  const hasExpMod   = fund.expenseModifier      != null && fund.expenseModifier      !== 0;

  const handleSectorClick = (name) => {
    setActiveSector(prev => (prev === name ? null : name));
  };

  return (
    <>
      {/* ── Backdrop ──────────────────────────────────────────────────────── */}
      <div
        onClick={() => selectFund(null)}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 149,
        }}
      />

      {/* ── Panel ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          height: '100vh',
          width: 420,
          background: '#16181c',
          borderLeft: '1px solid #25282e',
          zIndex: 150,
          overflowY: 'auto',
          overflowX: 'hidden',
          animation: 'fl_slideRight 200ms ease forwards',
        }}
      >
        {/* Keyframe injection */}
        <style>{`
          @keyframes fl_slideRight {
            from { transform: translateX(100%); }
            to   { transform: translateX(0); }
          }
        `}</style>

        {/* Close button */}
        <button
          onClick={() => selectFund(null)}
          style={{
            position: 'sticky',
            top: 0,
            float: 'right',
            zIndex: 10,
            background: 'none',
            border: 'none',
            color: '#6b7280',
            fontSize: 22,
            cursor: 'pointer',
            padding: '14px 16px 0',
            lineHeight: 1,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#e2e8f0')}
          onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
        >
          ×
        </button>

        {/* ── Scrollable content ─────────────────────────────────────────── */}
        <div style={{ padding: '20px 24px 48px', clear: 'both' }}>

          {/* ════════════════════════════════════════════════════════════════
              TOP SECTION — Identity + Composite + Factor bars
          ════════════════════════════════════════════════════════════════ */}
          <div style={{ marginBottom: 28 }}>
            {/* Fund name */}
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: '#f1f5f9',
                marginBottom: 4,
                paddingRight: 32,
                lineHeight: 1.3,
              }}
            >
              {fund.name}
            </div>

            {/* Ticker */}
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                color: '#3b82f6',
                fontSize: 13,
                marginBottom: 18,
              }}
            >
              {fund.ticker}
            </div>

            {/* Composite score + Tier badge */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 38,
                  fontWeight: 700,
                  color: '#f1f5f9',
                  lineHeight: 1,
                }}
              >
                {(fund.composite ?? 5.0).toFixed(1)}
              </div>
              <div style={{ paddingBottom: 3 }}>
                <TierBadge tier={tier} />
              </div>
            </div>

            {/* Z-Score + Allocation */}
            <div
              style={{
                display: 'flex',
                gap: 18,
                fontSize: 12,
                color: '#9ca3af',
                marginBottom: 20,
              }}
            >
              <span>Z&thinsp;{modZDisplay}</span>
              <span>{allocDisplay}</span>
            </div>

            {/* Factor bars */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {FACTOR_KEYS.map(key => (
                <FactorBar
                  key={key}
                  label={FACTOR_LABELS[key]}
                  score={fund[key]}
                />
              ))}
            </div>

            {/* Modifiers (only shown when non-zero) */}
            {(hasPenalty || hasExpMod) && (
              <div
                style={{
                  marginTop: 14,
                  fontSize: 11,
                  color: '#6b7280',
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                {hasPenalty && (
                  <span>
                    Concentration{' '}
                    {fund.concentrationPenalty > 0 ? '+' : ''}
                    {fund.concentrationPenalty.toFixed(2)}
                  </span>
                )}
                {hasExpMod && (
                  <span>
                    Expense mod{' '}
                    {fund.expenseModifier > 0 ? '+' : ''}
                    {fund.expenseModifier.toFixed(2)}
                  </span>
                )}
              </div>
            )}
          </div>

          <PanelDivider />

          {/* ════════════════════════════════════════════════════════════════
              MIDDLE SECTION — Sector Donut
          ════════════════════════════════════════════════════════════════ */}
          <div style={{ marginBottom: 28 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: '#6b7280',
                marginBottom: 16,
              }}
            >
              Sector Exposure
            </div>

            {holdings.length === 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: '#4b5563',
                  textAlign: 'center',
                  padding: '20px 0',
                  fontStyle: 'italic',
                }}
              >
                No holdings data available
              </div>
            ) : (
              <SectorDonut
                holdings={holdings}
                activeSector={activeSector}
                onSectorClick={handleSectorClick}
              />
            )}
          </div>

          <PanelDivider />

          {/* ════════════════════════════════════════════════════════════════
              BOTTOM SECTION — AI Reasoning
          ════════════════════════════════════════════════════════════════ */}
          <ReasoningBlock
            title="Macro Fit Analysis"
            text={mandateReasoning}
          />
          <ReasoningBlock
            title="Management Quality"
            text={managerReasoning}
          />
        </div>
      </div>
    </>
  );
}
