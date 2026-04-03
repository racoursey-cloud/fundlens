// =============================================================================
// FundLens v5 — src/components/thesis/ThesisTab.jsx
// Transparency layer into the scoring black box.
// Sections: Dominant Theme Banner · Sector Scorecard · Market Analysis ·
//           Risks + Catalysts · Fund Rankings
// =============================================================================

import { useMemo } from 'react';
import useAppStore from '../../store/useAppStore.js';
import { GICS_SECTORS, FACTOR_LABELS, FACTOR_KEYS, getTierFromModZ } from '../../engine/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(raw) {
  if (!raw) return null;
  try {
    return new Date(raw).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return null;
  }
}

function scoreColor(score) {
  const s = Number(score);
  if (s >= 7) return '#22c55e';   // green
  if (s <= 4) return '#ef4444';   // red
  return '#f1f5f9';               // white
}

function stanceColor(stance) {
  if (!stance) return '#6b7280';
  const s = stance.toLowerCase();
  if (s === 'risk-on')  return '#22c55e';
  if (s === 'risk-off') return '#ef4444';
  return '#d97706'; // mixed → amber
}

function outlookColor(outlook) {
  if (!outlook) return '#6b7280';
  const o = outlook.toLowerCase();
  if (o === 'bullish') return '#22c55e';
  if (o === 'bearish') return '#ef4444';
  return '#6b7280';
}

function stanceLabel(stance) {
  if (!stance) return '—';
  const s = stance.toLowerCase();
  if (s === 'risk-on')  return 'RISK-ON';
  if (s === 'risk-off') return 'RISK-OFF';
  return 'MIXED';
}

function outlookLabel(outlook) {
  if (!outlook) return '—';
  return outlook.toUpperCase();
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function Badge({ label, color, bg }) {
  return (
    <span
      style={{
        display:       'inline-flex',
        alignItems:    'center',
        padding:       '3px 10px',
        borderRadius:  '9999px',
        fontSize:      '11px',
        fontWeight:    700,
        letterSpacing: '0.06em',
        color:         color ?? '#f1f5f9',
        background:    bg ?? 'rgba(255,255,255,0.07)',
        border:        `1px solid ${color ?? '#6b7280'}40`,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — Dominant Theme Banner
// ---------------------------------------------------------------------------

function DominantThemeBanner({ thesis }) {
  const dateStr   = fmtDate(thesis?.generatedAt ?? thesis?.runAt ?? thesis?.lastRun);
  const stance    = thesis?.macroStance;
  const outlook   = thesis?.quarterOutlook;
  const riskLevel = thesis?.riskLevel;

  return (
    <div
      style={{
        background:   'linear-gradient(135deg, #0e0f11 0%, #1e293b 100%)',
        border:       '1px solid #25282e',
        borderRadius: '12px',
        padding:      '28px 32px 24px',
        marginBottom: '20px',
      }}
    >
      {/* Label row */}
      <p
        style={{
          fontSize:      '10px',
          fontWeight:    700,
          letterSpacing: '0.12em',
          color:         '#64748b',
          marginBottom:  '10px',
          fontFamily:    '"JetBrains Mono", monospace',
        }}
      >
        DOMINANT THEME{dateStr ? ` · ${dateStr}` : ''}
      </p>

      {/* Theme headline */}
      <h1
        style={{
          fontSize:     '26px',
          fontWeight:   700,
          color:        '#f1f5f9',
          marginBottom: '18px',
          lineHeight:   1.25,
          fontFamily:   'Inter, sans-serif',
        }}
      >
        {thesis?.dominantTheme ?? '—'}
      </h1>

      {/* Badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        {stance && (
          <Badge
            label={stanceLabel(stance)}
            color={stanceColor(stance)}
          />
        )}
        {outlook && (
          <Badge
            label={outlookLabel(outlook)}
            color={outlookColor(outlook)}
          />
        )}
        {riskLevel && (
          <Badge
            label={String(riskLevel).toUpperCase()}
            color="#94a3b8"
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 2 — Sector Scorecard
// ---------------------------------------------------------------------------

function SectorCard({ sector, data }) {
  const sectorMeta  = GICS_SECTORS[sector];
  const dotColor    = sectorMeta?.color ?? '#6b7280';
  const score       = Number(data?.score ?? data ?? 0);
  const reason      = data?.reason ?? '';
  const barWidth    = Math.min(100, Math.max(0, score * 10));

  return (
    <div
      style={{
        background:    '#16181c',
        border:        '1px solid #25282e',
        borderRadius:  '10px',
        padding:       '14px 16px',
        display:       'flex',
        flexDirection: 'column',
        gap:           '8px',
      }}
    >
      {/* Top row: dot + name | reason | score */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        {/* Left: dot + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '140px' }}>
          <span
            style={{
              width:        '8px',
              height:       '8px',
              borderRadius: '50%',
              background:   dotColor,
              flexShrink:   0,
              marginTop:    '2px',
            }}
          />
          <span
            style={{
              fontSize:   '13px',
              fontWeight: 600,
              color:      '#e2e8f0',
              lineHeight: 1.3,
            }}
          >
            {sector}
          </span>
        </div>

        {/* Center: reason */}
        <p
          style={{
            flex:       1,
            fontSize:   '12px',
            color:      '#94a3b8',
            lineHeight: 1.5,
            margin:     0,
          }}
        >
          {reason}
        </p>

        {/* Right: score */}
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize:   '14px',
            fontWeight: 700,
            color:      scoreColor(score),
            whiteSpace: 'nowrap',
            marginLeft: '8px',
          }}
        >
          {score.toFixed(0)}/10
        </span>
      </div>

      {/* Bar */}
      <div
        style={{
          height:       '6px',
          borderRadius: '3px',
          background:   '#25282e',
          overflow:     'hidden',
        }}
      >
        <div
          style={{
            height:       '100%',
            width:        `${barWidth}%`,
            background:   dotColor,
            borderRadius: '3px',
            transition:   'width 0.4s ease',
          }}
        />
      </div>
    </div>
  );
}

function SectorScorecard({ sectorScores }) {
  const sorted = useMemo(() => {
    if (!sectorScores) return [];

    return Object.keys(GICS_SECTORS)
      .filter(s => sectorScores[s] != null)
      .sort((a, b) => {
        const sa = Number(sectorScores[a]?.score ?? sectorScores[a] ?? 0);
        const sb = Number(sectorScores[b]?.score ?? sectorScores[b] ?? 0);
        return sb - sa;
      });
  }, [sectorScores]);

  if (!sectorScores || sorted.length === 0) return null;

  return (
    <div style={{ marginBottom: '20px' }}>
      <h2 style={sectionHeadingStyle}>Sector Scorecard</h2>

      {/* 2-col desktop grid via CSS custom property trick with inline style */}
      <div
        style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap:                 '10px',
        }}
        className="sector-grid"
      >
        {sorted.map(sector => (
          <SectorCard
            key={sector}
            sector={sector}
            data={sectorScores[sector]}
          />
        ))}
      </div>

      {/* Responsive override — inline style can't do media queries; use a style tag */}
      <style>{`
        @media (max-width: 640px) {
          .sector-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 3 — Market Analysis
// ---------------------------------------------------------------------------

function MarketAnalysis({ thesis, worldData }) {
  const narrative = thesis?.thesis ?? thesis?.narrative ?? '';

  // Derive source counts from worldData if available
  const fredCount  = worldData?.fredSeries?.length ?? worldData?.fred?.length ?? null;
  const gdeltCount = worldData?.gdeltHeadlines?.length ?? worldData?.gdelt?.length ?? null;

  const hasSources = fredCount != null || gdeltCount != null;

  // Split narrative into paragraphs on double newlines or single newlines
  const paragraphs = narrative
    ? narrative.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
    : [];

  if (!narrative) return null;

  return (
    <div style={{ ...cardStyle, marginBottom: '20px' }}>
      <h2 style={cardHeadingStyle}>Market Analysis</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {paragraphs.length > 0 ? (
          paragraphs.map((para, i) => (
            <p
              key={i}
              style={{
                fontSize:   '14px',
                color:      '#cbd5e1',
                lineHeight: 1.75,
                margin:     0,
              }}
            >
              {para}
            </p>
          ))
        ) : (
          <p
            style={{
              fontSize:   '14px',
              color:      '#cbd5e1',
              lineHeight: 1.75,
              margin:     0,
            }}
          >
            {narrative}
          </p>
        )}
      </div>

      {hasSources && (
        <p
          style={{
            marginTop:     '18px',
            paddingTop:    '14px',
            borderTop:     '1px solid #25282e',
            fontSize:      '11px',
            color:         '#475569',
            fontFamily:    '"JetBrains Mono", monospace',
            letterSpacing: '0.04em',
          }}
        >
          SOURCES:{' '}
          {fredCount  != null ? `FRED ${fredCount} series` : ''}
          {fredCount  != null && gdeltCount != null ? ', ' : ''}
          {gdeltCount != null ? `GDELT ${gdeltCount} headlines` : ''}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 4 — Risks + Catalysts
// ---------------------------------------------------------------------------

function ListCard({ title, items, accentColor }) {
  const list = Array.isArray(items) ? items : [];

  return (
    <div
      style={{
        ...cardStyle,
        borderTop: `2px solid ${accentColor}`,
      }}
    >
      <h2
        style={{
          ...cardHeadingStyle,
          color: accentColor,
        }}
      >
        {title}
      </h2>

      {list.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#475569', margin: 0 }}>—</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {list.map((item, i) => (
            <li
              key={i}
              style={{
                display:    'flex',
                alignItems: 'flex-start',
                gap:        '8px',
                fontSize:   '13px',
                color:      '#cbd5e1',
                lineHeight: 1.6,
              }}
            >
              <span
                style={{
                  marginTop:  '6px',
                  flexShrink: 0,
                  width:      '5px',
                  height:     '5px',
                  borderRadius: '50%',
                  background: accentColor,
                }}
              />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RisksAndCatalysts({ thesis }) {
  return (
    <div
      style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap:                 '16px',
        marginBottom:        '20px',
      }}
      className="rc-grid"
    >
      <ListCard
        title="Risk Factors"
        items={thesis?.riskFactors}
        accentColor="#ef4444"
      />
      <ListCard
        title="Catalysts"
        items={thesis?.catalysts}
        accentColor="#22c55e"
      />
      <style>{`
        @media (max-width: 640px) {
          .rc-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 5 — Fund Rankings (mirrored from Portfolio tab)
// ---------------------------------------------------------------------------

function FactorBars({ fund }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '120px' }}>
      {FACTOR_KEYS.map(key => {
        const score = Number(fund[key] ?? 5);
        const width = Math.min(100, Math.max(0, score * 10));
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span
              style={{
                fontSize:    '9px',
                color:       '#475569',
                fontFamily:  '"JetBrains Mono", monospace',
                width:       '56px',
                flexShrink:  0,
                letterSpacing: '0.02em',
              }}
            >
              {(FACTOR_LABELS[key] ?? key).toUpperCase().slice(0, 8)}
            </span>
            <div
              style={{
                flex:         1,
                height:       '6px',
                background:   '#25282e',
                borderRadius: '3px',
                overflow:     'hidden',
              }}
            >
              <div
                style={{
                  height:       '100%',
                  width:        `${width}%`,
                  background:   '#3b82f6',
                  borderRadius: '3px',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TierBadge({ tier }) {
  if (tier == null) return null;
  const resolved = getTierFromModZ(tier);
  if (!resolved) return null;

  if (resolved.label === 'MM') {
    return (
      <span
        style={{
          fontSize:      '10px',
          fontWeight:    600,
          color:         '#6b7280',
          fontFamily:    '"JetBrains Mono", monospace',
          letterSpacing: '0.05em',
        }}
      >
        MM
      </span>
    );
  }

  return (
    <span
      style={{
        display:       'inline-block',
        padding:       '2px 8px',
        borderRadius:  '4px',
        fontSize:      '10px',
        fontWeight:    700,
        letterSpacing: '0.07em',
        color:         resolved.color,
        background:    `${resolved.color}18`,
        border:        `1px solid ${resolved.color}40`,
        fontFamily:    '"JetBrains Mono", monospace',
        whiteSpace:    'nowrap',
      }}
    >
      {resolved.label}
    </span>
  );
}

function FundRankingsTable({ funds, selectedFund, selectFund }) {
  const sorted = useMemo(() => {
    if (!funds || funds.length === 0) return [];
    return [...funds].sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));
  }, [funds]);

  if (sorted.length === 0) return null;

  return (
    <div style={{ marginBottom: '20px' }}>
      <h2 style={sectionHeadingStyle}>Fund Rankings</h2>

      <div
        style={{
          background:    '#16181c',
          border:        '1px solid #25282e',
          borderRadius:  '10px',
          overflow:      'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display:          'grid',
            gridTemplateColumns: '36px 68px 1fr 64px 80px 1fr',
            gap:              '0 8px',
            padding:          '10px 16px',
            borderBottom:     '1px solid #25282e',
            background:       '#0e0f11',
          }}
        >
          {['#', 'Ticker', 'Name', 'Score', 'Tier', 'Factors'].map(h => (
            <span
              key={h}
              style={{
                fontSize:      '10px',
                fontWeight:    600,
                color:         '#475569',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontFamily:    '"JetBrains Mono", monospace',
              }}
            >
              {h}
            </span>
          ))}
        </div>

        {/* Rows */}
        {sorted.map((fund, i) => {
          const isSelected = selectedFund === fund.ticker;
          return (
            <div
              key={fund.ticker}
              onClick={() => selectFund(isSelected ? null : fund.ticker)}
              style={{
                display:          'grid',
                gridTemplateColumns: '36px 68px 1fr 64px 80px 1fr',
                gap:              '0 8px',
                padding:          '12px 16px',
                borderBottom:     i < sorted.length - 1 ? '1px solid #25282e' : 'none',
                borderLeft:       isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                background:       isSelected ? '#1c2333' : 'transparent',
                cursor:           'pointer',
                alignItems:       'center',
                transition:       'background 0.15s ease',
              }}
              onMouseEnter={e => {
                if (!isSelected) e.currentTarget.style.background = '#1c1e23';
              }}
              onMouseLeave={e => {
                if (!isSelected) e.currentTarget.style.background = 'transparent';
              }}
            >
              {/* Rank */}
              <span
                style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize:   '12px',
                  color:      '#475569',
                }}
              >
                {i + 1}
              </span>

              {/* Ticker */}
              <span
                style={{
                  fontFamily:  '"JetBrains Mono", monospace',
                  fontSize:    '12px',
                  fontWeight:  700,
                  color:       '#3b82f6',
                  letterSpacing: '0.04em',
                }}
              >
                {fund.ticker}
              </span>

              {/* Name */}
              <span
                style={{
                  fontSize:     '13px',
                  color:        '#cbd5e1',
                  overflow:     'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace:   'nowrap',
                }}
              >
                {fund.name}
              </span>

              {/* Composite score */}
              <span
                style={{
                  fontFamily:  '"JetBrains Mono", monospace',
                  fontSize:    '13px',
                  fontWeight:  700,
                  color:       scoreColor(fund.composite ?? 5),
                  textAlign:   'right',
                }}
              >
                {Number(fund.composite ?? 5).toFixed(1)}
              </span>

              {/* Tier */}
              <div>
                <TierBadge tier={fund.modZ} />
              </div>

              {/* Factor bars */}
              <FactorBars fund={fund} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        padding:        '80px 24px',
        gap:            '16px',
        textAlign:      'center',
      }}
    >
      {/* Icon */}
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <rect width="48" height="48" rx="10" fill="#16181c" />
        <path
          d="M14 24h4M20 18h4M26 28h4M32 20h4"
          stroke="#25282e"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="24" cy="24" r="10" stroke="#25282e" strokeWidth="2" />
        <path
          d="M20 24l3 3 5-6"
          stroke="#3b82f6"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <p
        style={{
          fontSize:   '15px',
          color:      '#475569',
          lineHeight: 1.6,
          maxWidth:   '340px',
          margin:     0,
        }}
      >
        No analysis yet. Run your first analysis to see the investment thesis.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared style tokens
// ---------------------------------------------------------------------------

const cardStyle = {
  background:    '#16181c',
  border:        '1px solid #25282e',
  borderRadius:  '10px',
  padding:       '20px',
};

const cardHeadingStyle = {
  fontSize:      '13px',
  fontWeight:    700,
  letterSpacing: '0.06em',
  color:         '#94a3b8',
  marginBottom:  '16px',
  textTransform: 'uppercase',
  fontFamily:    'Inter, sans-serif',
};

const sectionHeadingStyle = {
  fontSize:      '13px',
  fontWeight:    700,
  letterSpacing: '0.06em',
  color:         '#94a3b8',
  marginBottom:  '12px',
  textTransform: 'uppercase',
  fontFamily:    'Inter, sans-serif',
};

// ---------------------------------------------------------------------------
// ThesisTab — root export
// ---------------------------------------------------------------------------

export default function ThesisTab() {
  const thesis       = useAppStore(s => s.thesis);
  const sectorScores = useAppStore(s => s.sectorScores);
  const worldData    = useAppStore(s => s.worldData);
  const funds        = useAppStore(s => s.funds);
  const selectedFund = useAppStore(s => s.selectedFund);
  const selectFund   = useAppStore(s => s.selectFund);

  const hasData = thesis != null;

  return (
    <div
      style={{
        padding:   '20px 24px',
        maxWidth:  '900px',
        margin:    '0 auto',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {!hasData ? (
        <EmptyState />
      ) : (
        <>
          <DominantThemeBanner thesis={thesis} />
          <SectorScorecard sectorScores={sectorScores} />
          <MarketAnalysis thesis={thesis} worldData={worldData} />
          <RisksAndCatalysts thesis={thesis} />
          <FundRankingsTable
            funds={funds}
            selectedFund={selectedFund}
            selectFund={selectFund}
          />
        </>
      )}
    </div>
  );
}
