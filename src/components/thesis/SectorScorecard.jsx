import { GICS_SECTORS } from '../../engine/constants.js';

// Score to label mapping
function scoreLabel(score) {
  if (score >= 8) return 'Strong tailwinds';
  if (score >= 6) return 'Favorable';
  if (score >= 4.5) return 'Neutral';
  if (score >= 3) return 'Headwinds';
  return 'Strong headwinds';
}

export default function SectorScorecard({ sectorScores }) {
  if (!sectorScores || !Object.keys(sectorScores).length) return null;

  // Sort sectors by score descending
  const sorted = Object.entries(sectorScores).sort((a, b) => b[1].score - a[1].score);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {sorted.map(([sector, data]) => {
        const color = GICS_SECTORS[sector]?.color ?? '#6b7280';
        const score = data.score ?? 5;
        const pct = ((score - 1) / 9) * 100; // 1–10 mapped to 0–100%

        return (
          <div
            key={sector}
            style={{
              display: 'grid',
              gridTemplateColumns: '180px 52px 1fr',
              alignItems: 'center',
              gap: '12px',
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
          >
            {/* Sector name with color dot */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#e5e7eb',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {sector}
              </span>
            </div>

            {/* Score badge */}
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '13px',
                fontWeight: 700,
                color: color,
                textAlign: 'right',
              }}
            >
              {score.toFixed(1)}
            </div>

            {/* Score bar + reasoning */}
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  height: '6px',
                  borderRadius: '3px',
                  background: 'rgba(255,255,255,0.06)',
                  overflow: 'hidden',
                  marginBottom: '5px',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${pct}%`,
                    borderRadius: '3px',
                    background: color,
                    opacity: 0.85,
                    transition: 'width 0.5s ease-out',
                  }}
                />
              </div>
              <p
                style={{
                  fontSize: '11px',
                  color: '#9ca3af',
                  lineHeight: 1.4,
                  margin: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={data.reasoning || scoreLabel(score)}
              >
                {data.reasoning || scoreLabel(score)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
