import { useAppStore } from '../../store/useAppStore.js';
import SectorScorecard from './SectorScorecard.jsx';

const STANCE_CONFIG = {
  bullish:       { label: 'Bullish',       color: '#22c55e', bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.2)'  },
  bearish:       { label: 'Bearish',       color: '#ef4444', bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.2)'  },
  neutral:       { label: 'Neutral',       color: '#eab308', bg: 'rgba(234,179,8,0.08)',  border: 'rgba(234,179,8,0.2)'  },
  transitional:  { label: 'Transitional',  color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.2)' },
};

export default function ThesisTab() {
  const investmentThesis = useAppStore(s => s.investmentThesis);
  const dominantTheme    = useAppStore(s => s.dominantTheme);
  const macroStance      = useAppStore(s => s.macroStance);
  const sectorScores     = useAppStore(s => s.sectorScores);
  const lastRun          = useAppStore(s => s.lastRun);

  // No data yet — show prompt
  if (!investmentThesis) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <div style={{ fontSize: '40px', marginBottom: '14px' }}>{'\uD83C\uDF0D'}</div>
        <h2 style={{ fontFamily: "'Libre Baskerville', serif", fontSize: '18px', marginBottom: '8px' }}>
          Investment Thesis
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text3)', maxWidth: '360px', margin: '0 auto' }}>
          Run Analysis to generate your macro thesis and sector outlook.
        </p>
      </div>
    );
  }

  const stance = STANCE_CONFIG[macroStance] ?? STANCE_CONFIG.neutral;

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* -- Thesis Card ---------------------------------------- */}
      <div
        className="card"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: "'Libre Baskerville', serif", fontWeight: 700, fontSize: '15px' }}>
            Investment Thesis
          </span>
          {lastRun && (
            <span style={{ fontSize: '11px', color: 'var(--text3)' }}>
              {new Date(lastRun).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {' '}
              {new Date(lastRun).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Stance + Theme row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Macro stance badge */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
                color: stance.color,
                background: stance.bg,
                border: `1px solid ${stance.border}`,
              }}
            >
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%',
                backgroundColor: stance.color,
              }} />
              {stance.label}
            </span>

            {/* Dominant theme badge */}
            {dominantTheme && dominantTheme !== 'Unavailable' && (
              <span
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#93c5fd',
                  background: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.2)',
                }}
              >
                {dominantTheme}
              </span>
            )}
          </div>

          {/* Thesis text */}
          <p
            style={{
              fontSize: '14px',
              lineHeight: 1.75,
              color: '#d1d5db',
              margin: 0,
              maxWidth: '720px',
            }}
          >
            {investmentThesis}
          </p>
        </div>
      </div>

      {/* -- Sector Scorecard Card ------------------------------ */}
      <div
        className="card"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: "'Libre Baskerville', serif", fontWeight: 700, fontSize: '15px' }}>
            Sector Outlook
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text3)' }}>
            11 GICS sectors scored 1{'\u2013'}10
          </span>
        </div>
        <div className="card-body">
          <SectorScorecard sectorScores={sectorScores} />
        </div>
      </div>
    </div>
  );
}
