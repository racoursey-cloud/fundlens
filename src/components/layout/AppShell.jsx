// =============================================================================
// FundLens v5 — src/components/layout/AppShell.jsx
// Main application shell rendered after login + wizard.
// Owns the sticky header, three-tab bar, content area, and overlay layer.
// All state is read from useAppStore — no local state except what is
// purely cosmetic (e.g. hover effects handled via CSS / inline style hacks).
// =============================================================================

import useAppStore from '../../store/useAppStore.js';
import PipelineOverlay   from './PipelineOverlay.jsx';
import DataQualityBanner from './DataQualityBanner.jsx';

// ─── Tab placeholder components ───────────────────────────────────────────────
// Replaced in Phase 3 (P3-3, P3-4, P3-5) when the real tab files are uploaded.
const PortfolioTab = () => (
  <div style={{ padding: '40px', color: '#6b7280', fontFamily: 'Inter, sans-serif', fontSize: 14 }}>
    Portfolio tab — coming in P3-3
  </div>
);

const ThesisTab = () => (
  <div style={{ padding: '40px', color: '#6b7280', fontFamily: 'Inter, sans-serif', fontSize: 14 }}>
    Thesis tab — coming in P3-4
  </div>
);

const SettingsTab = () => (
  <div style={{ padding: '40px', color: '#6b7280', fontFamily: 'Inter, sans-serif', fontSize: 14 }}>
    Settings tab — coming in P3-5
  </div>
);

// Replaced in P3-6 when the real sidebar file is uploaded.
const FundDetailSidebar = () => null;

// ─── Source badge ─────────────────────────────────────────────────────────────
function SourceBadge({ source }) {
  if (source === 'live') {
    return (
      <span style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            5,
        padding:        '3px 10px',
        borderRadius:   20,
        fontSize:       11,
        fontWeight:     700,
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        fontFamily:     'Inter, sans-serif',
        background:     'rgba(5, 150, 105, 0.15)',
        color:          '#10b981',
        border:         '1px solid rgba(5, 150, 105, 0.35)',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: '#10b981', display: 'inline-block',
        }} />
        LIVE
      </span>
    );
  }

  if (source === 'loading') {
    return (
      <span style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            6,
        padding:        '3px 10px',
        borderRadius:   20,
        fontSize:       11,
        fontWeight:     700,
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        fontFamily:     'Inter, sans-serif',
        background:     'rgba(59, 130, 246, 0.15)',
        color:          '#3b82f6',
        border:         '1px solid rgba(59, 130, 246, 0.35)',
      }}>
        <span style={{
          width:          12,
          height:         12,
          border:         '2px solid rgba(59,130,246,0.35)',
          borderTopColor: '#3b82f6',
          borderRadius:   '50%',
          display:        'inline-block',
          animation:      'fl-spin 0.75s linear infinite',
          flexShrink:     0,
        }} />
        ANALYZING…
      </span>
    );
  }

  // 'seed' (default)
  return (
    <span style={{
      display:        'inline-flex',
      alignItems:     'center',
      gap:            5,
      padding:        '3px 10px',
      borderRadius:   20,
      fontSize:       11,
      fontWeight:     700,
      letterSpacing:  '0.08em',
      textTransform:  'uppercase',
      fontFamily:     'Inter, sans-serif',
      background:     'rgba(107, 114, 128, 0.15)',
      color:          '#9ca3af',
      border:         '1px solid rgba(107, 114, 128, 0.30)',
    }}>
      SEED DATA
    </span>
  );
}

// ─── Tab definitions ──────────────────────────────────────────────────────────
const TABS = [
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'thesis',    label: 'Thesis'    },
  { key: 'settings',  label: 'Settings'  },
];

// ─── AppShell ─────────────────────────────────────────────────────────────────
export default function AppShell() {
  const {
    profile,
    user,
    source,
    isRunning,
    activeTab,
    dataQuality,
    setActiveTab,
    runPipelineAction,
  } = useAppStore();

  // Display name: prefer profile name, fall back to email, then 'User'
  const displayName =
    profile?.name?.trim() ||
    user?.email?.split('@')[0] ||
    'User';

  return (
    <div style={{
      minHeight:   '100vh',
      background:  '#0e0f11',
      display:     'flex',
      flexDirection: 'column',
      fontFamily:  'Inter, sans-serif',
    }}>

      {/* ── Keyframe injection ─────────────────────────────────────────────── */}
      <style>{`
        @keyframes fl-spin {
          to { transform: rotate(360deg); }
        }
        .fl-tab-btn {
          background: none;
          border: none;
          cursor: pointer;
          outline: none;
        }
        .fl-tab-btn:focus-visible {
          outline: 2px solid #3b82f6;
          outline-offset: -2px;
          border-radius: 2px;
        }
        .fl-run-btn:hover:not(:disabled) {
          background: #2563eb !important;
        }
        .fl-run-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>

      {/* ═══════════════════════════════════════════════════════════════════════
          HEADER
      ══════════════════════════════════════════════════════════════════════════ */}
      <header style={{
        position:      'sticky',
        top:           0,
        zIndex:        100,
        height:        56,
        background:    '#16181c',
        borderBottom:  '1px solid #25282e',
        display:       'flex',
        alignItems:    'center',
        padding:       '0 20px',
        gap:           16,
        flexShrink:    0,
      }}>

        {/* Logo */}
        <div style={{
          fontSize:   18,
          fontWeight: 700,
          letterSpacing: '-0.01em',
          flexShrink: 0,
          userSelect: 'none',
        }}>
          <span style={{ color: '#f9fafb' }}>Fund</span>
          <span style={{ color: '#3b82f6' }}>Lens</span>
        </div>

        {/* Source badge — center-left */}
        <div style={{ flexShrink: 0 }}>
          <SourceBadge source={source} />
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Run Analysis button */}
        <button
          className="fl-run-btn"
          disabled={isRunning}
          onClick={() => runPipelineAction()}
          style={{
            display:       'inline-flex',
            alignItems:    'center',
            gap:           7,
            padding:       '0 18px',
            height:        34,
            background:    '#3b82f6',
            color:         '#fff',
            fontFamily:    'Inter, sans-serif',
            fontSize:      13,
            fontWeight:    600,
            border:        'none',
            borderRadius:  8,
            cursor:        'pointer',
            transition:    'background 0.15s',
            flexShrink:    0,
            letterSpacing: '0.01em',
          }}
        >
          {isRunning && (
            <span style={{
              width:          13,
              height:         13,
              border:         '2px solid rgba(255,255,255,0.35)',
              borderTopColor: '#fff',
              borderRadius:   '50%',
              display:        'inline-block',
              animation:      'fl-spin 0.75s linear infinite',
              flexShrink:     0,
            }} />
          )}
          {isRunning ? 'Analyzing…' : 'Run Analysis'}
        </button>

        {/* User identity */}
        <div style={{
          fontSize:   12,
          color:      '#6b7280',
          fontFamily: 'Inter, sans-serif',
          flexShrink: 0,
          maxWidth:   160,
          overflow:   'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {displayName}
        </div>

      </header>

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB BAR
      ══════════════════════════════════════════════════════════════════════════ */}
      <div style={{
        background:   '#0e0f11',
        borderBottom: '1px solid #25282e',
        display:      'flex',
        gap:          0,
        padding:      '0 20px',
        flexShrink:   0,
      }}>
        {TABS.map(({ key, label }) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              className="fl-tab-btn"
              onClick={() => setActiveTab(key)}
              style={{
                padding:        '0 16px',
                height:         40,
                fontSize:       12,
                fontWeight:     600,
                textTransform:  'uppercase',
                letterSpacing:  '0.08em',
                fontFamily:     'Inter, sans-serif',
                color:          isActive ? '#f9fafb' : '#6b7280',
                borderBottom:   isActive ? '2px solid #3b82f6' : '2px solid transparent',
                marginBottom:   -1,   // sit on top of container border
                transition:     'color 0.15s',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          DATA QUALITY BANNER (amber, below tabs)
      ══════════════════════════════════════════════════════════════════════════ */}
      <DataQualityBanner />

      {/* ═══════════════════════════════════════════════════════════════════════
          CONTENT AREA
      ══════════════════════════════════════════════════════════════════════════ */}
      <main style={{
        flex:       1,
        overflowY:  'auto',
        background: '#0e0f11',
      }}>
        {activeTab === 'portfolio' && <PortfolioTab />}
        {activeTab === 'thesis'    && <ThesisTab />}
        {activeTab === 'settings'  && <SettingsTab />}
      </main>

      {/* ═══════════════════════════════════════════════════════════════════════
          OVERLAYS — always in the tree, visibility controlled by store state
      ══════════════════════════════════════════════════════════════════════════ */}
      <PipelineOverlay />
      <FundDetailSidebar />

    </div>
  );
}
