// =============================================================================
// FundLens v5 — src/components/layout/PipelineOverlay.jsx
// Full-screen overlay displayed during pipeline execution.
// Reads isRunning, pipelineStep, and pipelineDetail from useAppStore.
// Returns null when the pipeline is not running.
// =============================================================================

import useAppStore    from '../../store/useAppStore.js';
import { PIPELINE_STEPS } from '../../engine/constants.js';

// ─── Step dot ─────────────────────────────────────────────────────────────────
// done    → green circle with ✓
// active  → blue spinner
// pending → gray circle with step number
function StepDot({ index, status }) {
  const stepNum = index + 1;

  if (status === 'done') {
    return (
      <span style={{
        width:          22,
        height:         22,
        borderRadius:   '50%',
        background:     '#059669',
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        flexShrink:     0,
        fontSize:       12,
        color:          '#fff',
        fontWeight:     700,
      }}>
        ✓
      </span>
    );
  }

  if (status === 'active') {
    return (
      <span style={{
        width:          22,
        height:         22,
        borderRadius:   '50%',
        border:         '2.5px solid rgba(59,130,246,0.30)',
        borderTopColor: '#3b82f6',
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        flexShrink:     0,
        animation:      'fl-spin 0.75s linear infinite',
      }} />
    );
  }

  // pending
  return (
    <span style={{
      width:          22,
      height:         22,
      borderRadius:   '50%',
      background:     '#25282e',
      display:        'inline-flex',
      alignItems:     'center',
      justifyContent: 'center',
      flexShrink:     0,
      fontSize:       11,
      fontWeight:     700,
      color:          '#4b5563',
      fontFamily:     'Inter, sans-serif',
    }}>
      {stepNum}
    </span>
  );
}

// ─── PipelineOverlay ─────────────────────────────────────────────────────────
export default function PipelineOverlay() {
  const { isRunning, pipelineStep, pipelineDetail } = useAppStore();

  if (!isRunning) return null;

  // pipelineStep is 1-based (1 = first step running, 0 = just started)
  // step index in PIPELINE_STEPS is 0-based
  const currentIndex = Math.max(0, pipelineStep - 1); // 0-based active step
  const progressPct  = Math.min(100, (pipelineStep / PIPELINE_STEPS.length) * 100);

  return (
    <>
      <style>{`
        @keyframes fl-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Full-screen backdrop */}
      <div style={{
        position:       'fixed',
        inset:          0,
        zIndex:         200,
        background:     'rgba(14, 15, 17, 0.95)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        padding:        '24px 16px',
      }}>

        {/* Card */}
        <div style={{
          background:   '#16181c',
          border:       '1px solid #25282e',
          borderRadius: 16,
          padding:      '32px 36px',
          width:        '100%',
          maxWidth:     520,
          boxShadow:    '0 24px 64px rgba(0,0,0,0.60)',
        }}>

          {/* ── Header ──────────────────────────────────────────────────────── */}
          <div style={{
            display:     'flex',
            alignItems:  'center',
            gap:         12,
            marginBottom: 24,
          }}>
            {/* Spinner */}
            <span style={{
              width:          20,
              height:         20,
              borderRadius:   '50%',
              border:         '2.5px solid rgba(59,130,246,0.25)',
              borderTopColor: '#3b82f6',
              display:        'inline-block',
              animation:      'fl-spin 0.75s linear infinite',
              flexShrink:     0,
            }} />
            <h2 style={{
              margin:      0,
              fontSize:    16,
              fontWeight:  700,
              color:       '#f9fafb',
              fontFamily:  'Inter, sans-serif',
              letterSpacing: '-0.01em',
            }}>
              Analyzing Your Funds
            </h2>
          </div>

          {/* ── Progress bar ────────────────────────────────────────────────── */}
          <div style={{
            width:        '100%',
            height:       5,
            background:   '#25282e',
            borderRadius: 99,
            overflow:     'hidden',
            marginBottom: 28,
          }}>
            <div style={{
              height:           '100%',
              width:            `${progressPct}%`,
              background:       '#3b82f6',
              borderRadius:     99,
              transition:       'width 0.4s ease',
            }} />
          </div>

          {/* ── Step list ───────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {PIPELINE_STEPS.map((label, i) => {
              let status;
              if (i < currentIndex)  status = 'done';
              else if (i === currentIndex) status = 'active';
              else                   status = 'pending';

              const isActive = status === 'active';
              const isDone   = status === 'done';

              return (
                <div
                  key={i}
                  style={{
                    display:     'flex',
                    flexDirection: 'column',
                    gap:         0,
                    padding:     '8px 0',
                    borderBottom: i < PIPELINE_STEPS.length - 1
                      ? '1px solid #1c1e23'
                      : 'none',
                  }}
                >
                  <div style={{
                    display:    'flex',
                    alignItems: 'center',
                    gap:        12,
                  }}>
                    <StepDot index={i} status={status} />

                    <span style={{
                      fontSize:   13,
                      fontFamily: 'Inter, sans-serif',
                      fontWeight: isActive ? 700 : 400,
                      color:      isDone   ? '#059669'
                                : isActive ? '#f9fafb'
                                :            '#6b7280',
                      transition: 'color 0.2s',
                      letterSpacing: '0.005em',
                    }}>
                      {label}
                    </span>
                  </div>

                  {/* Detail text — only on the active step, when present */}
                  {isActive && pipelineDetail && (
                    <div style={{
                      marginLeft:  34,   // dot (22) + gap (12)
                      marginTop:   4,
                      fontSize:    11,
                      color:       '#6b7280',
                      fontFamily:  'Inter, sans-serif',
                      lineHeight:  1.5,
                    }}>
                      {pipelineDetail}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        </div>
      </div>
    </>
  );
}
