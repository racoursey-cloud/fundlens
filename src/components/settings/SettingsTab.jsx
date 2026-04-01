// =============================================================================
// FundLens v5 — src/components/settings/SettingsTab.jsx
// Three sections: Profile · Data Sources · Fund Management · Data Refresh
// Reads from and writes to useAppStore. Source list loaded via cache.getEnabledSources.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import useAppStore from '../../store/useAppStore';
import { getEnabledSources } from '../../services/cache';
import { supabase } from '../../services/supabase';

// ---------------------------------------------------------------------------
// Sub-component: Toggle Switch
// ---------------------------------------------------------------------------
function Toggle({ enabled, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={enabled}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        border: 'none',
        background: enabled ? '#3b82f6' : '#374151',
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 200ms ease',
        padding: 0,
      }}
    >
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          position: 'absolute',
          top: 2,
          left: enabled ? 22 : 2,
          transition: 'left 200ms ease',
          pointerEvents: 'none',
        }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Source Toggle Row
// ---------------------------------------------------------------------------
function SourceRow({ source, enabled, onToggle }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 0',
        borderBottom: '1px solid #1c1e23',
      }}
    >
      <div style={{ flex: 1, marginRight: 16 }}>
        <div style={{ fontSize: 14, color: '#e2e8f0', marginBottom: 3 }}>
          {source.label}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>
          {source.description}
        </div>
      </div>
      <Toggle enabled={enabled} onToggle={onToggle} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Section Divider
// ---------------------------------------------------------------------------
function Divider() {
  return <div style={{ height: 1, background: '#25282e', margin: '8px 0 32px' }} />;
}

// ---------------------------------------------------------------------------
// Sub-component: Section Header
// ---------------------------------------------------------------------------
function SectionHeader({ children }) {
  return (
    <h2
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: '#6b7280',
        marginBottom: 20,
        margin: '0 0 20px',
      }}
    >
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function SettingsTab() {
  const {
    user,
    profile,
    dataSourcePrefs,
    funds,
    setDataSourcePrefs,
    addFund,
    removeFund,
    updateProfile,
  } = useAppStore();

  // Profile
  const [displayName, setDisplayName] = useState('');
  const [nameSaving, setNameSaving] = useState(false);

  // Sources
  const [sources, setSources] = useState([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);

  // Fund add
  const [addInput, setAddInput] = useState('');

  // Toast
  const [toast, setToast] = useState(null);

  // ── Init display name ────────────────────────────────────────────────────
  useEffect(() => {
    setDisplayName(profile?.display_name ?? '');
  }, [profile]);

  // ── Load sources on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    setSourcesLoading(true);
    getEnabledSources(user.id)
      .then(setSources)
      .catch(err => console.error('[SettingsTab] getEnabledSources failed:', err?.message))
      .finally(() => setSourcesLoading(false));
  }, [user?.id]);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const showToast = useCallback((msg, durationMs = 3500) => {
    setToast(msg);
    setTimeout(() => setToast(null), durationMs);
  }, []);

  /**
   * Determine whether a source is currently enabled, consulting the store's
   * live pref map first (so toggles reflect instantly) then falling back to
   * the value baked into the source object at load time.
   */
  const isSourceEnabled = useCallback(
    (source) => {
      if (Object.prototype.hasOwnProperty.call(dataSourcePrefs, source.id)) {
        return dataSourcePrefs[source.id];
      }
      return source.enabled;
    },
    [dataSourcePrefs]
  );

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleDisplayNameBlur = async () => {
    const trimmed = displayName.trim();
    if (trimmed === (profile?.display_name ?? '')) return;
    setNameSaving(true);
    await updateProfile({ display_name: trimmed });
    setNameSaving(false);
  };

  const handleToggle = (source) => {
    const current = isSourceEnabled(source);
    setDataSourcePrefs({ [source.id]: !current });
  };

  const handleAddFund = () => {
    const raw = addInput.trim();
    if (!raw) return;
    const tickers = raw.split(/[,\n\r\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
    tickers.forEach(ticker => addFund(ticker, ticker));
    setAddInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleAddFund();
  };

  const handleForceRefresh = () => {
    // Sets a flag that world.js checks to skip TTL cache on next run.
    // The flag lives in sessionStorage specifically for the engine — not localStorage.
    try { sessionStorage.setItem('fl_force_world_refresh', '1'); } catch (_) {}
    showToast('World data will refresh on next analysis run.');
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const worldSources   = sources.filter(s => s.category === 'world');
  const scoringSources = sources.filter(s => s.category === 'scoring');

  const allScoringOff =
    scoringSources.length > 0 &&
    scoringSources.every(s => !isSourceEnabled(s));

  // ── Input style shared ───────────────────────────────────────────────────
  const inputStyle = {
    background: '#1c1e23',
    border: '1px solid #25282e',
    borderRadius: 6,
    padding: '8px 12px',
    color: '#e2e8f0',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'Inter, sans-serif',
  };

  return (
    <div
      style={{
        maxWidth: 600,
        margin: '0 auto',
        padding: '32px 24px 64px',
        color: '#e2e8f0',
      }}
    >
      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            right: 20,
            background: '#1c1e23',
            border: '1px solid #3b82f6',
            color: '#e2e8f0',
            padding: '12px 18px',
            borderRadius: 8,
            zIndex: 9999,
            fontSize: 13,
            maxWidth: 320,
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
          }}
        >
          {toast}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* SECTION 1 — PROFILE                                               */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: 32 }}>
        <SectionHeader>Profile</SectionHeader>

        {/* Display Name */}
        <div style={{ marginBottom: 16 }}>
          <label
            style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}
          >
            Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            onBlur={handleDisplayNameBlur}
            placeholder="Your name"
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
          />
          {nameSaving && (
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Saving…</div>
          )}
        </div>

        {/* Company Code — read-only */}
        <div style={{ marginBottom: 24 }}>
          <label
            style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 6 }}
          >
            Company Code
          </label>
          <div
            style={{
              background: '#16181c',
              border: '1px solid #25282e',
              borderRadius: 6,
              padding: '8px 12px',
              color: '#6b7280',
              fontSize: 13,
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {profile?.company_code ?? '—'}
          </div>
        </div>

        {/* Sign Out */}
        <SignOutButton />
      </section>

      <Divider />

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* SECTION 2 — DATA SOURCES                                          */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: 32 }}>
        <SectionHeader>Data Sources</SectionHeader>

        {/* Amber warning */}
        {allScoringOff && (
          <div
            style={{
              background: '#78350f1a',
              border: '1px solid #d97706',
              borderRadius: 6,
              padding: '10px 14px',
              color: '#d97706',
              fontSize: 13,
              marginBottom: 20,
              lineHeight: 1.5,
            }}
          >
            All scoring sources disabled. Scores will be neutral (5.0).
          </div>
        )}

        {sourcesLoading && (
          <div style={{ fontSize: 13, color: '#6b7280', padding: '8px 0' }}>
            Loading sources…
          </div>
        )}

        {/* World Data Sources */}
        {!sourcesLoading && worldSources.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 4,
              }}
            >
              World Data Sources
            </div>
            {worldSources.map(source => (
              <SourceRow
                key={source.id}
                source={source}
                enabled={isSourceEnabled(source)}
                onToggle={() => handleToggle(source)}
              />
            ))}
          </div>
        )}

        {/* Scoring Sources */}
        {!sourcesLoading && scoringSources.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 4,
              }}
            >
              Scoring Sources
            </div>
            {scoringSources.map(source => (
              <SourceRow
                key={source.id}
                source={source}
                enabled={isSourceEnabled(source)}
                onToggle={() => handleToggle(source)}
              />
            ))}
          </div>
        )}
      </section>

      <Divider />

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* SECTION 3 — FUND MANAGEMENT                                       */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: 32 }}>
        <SectionHeader>Fund Management</SectionHeader>

        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
          {funds.length} fund{funds.length !== 1 ? 's' : ''} in your universe
        </div>

        {/* Chips */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 20,
          }}
        >
          {funds.map(fund => (
            <FundChip
              key={fund.ticker}
              ticker={fund.ticker}
              onRemove={() => removeFund(fund.ticker)}
            />
          ))}
        </div>

        {/* Add input */}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="FXAIX  or  FXAIX, VFIAX"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={handleAddFund}
            style={{
              background: '#3b82f6',
              border: 'none',
              borderRadius: 6,
              padding: '8px 18px',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Add
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
          Paste multiple tickers separated by commas or line breaks.
        </div>
      </section>

      <Divider />

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* SECTION 4 — DATA REFRESH                                          */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      <section>
        <SectionHeader>Data Refresh</SectionHeader>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {/* Force Refresh — enabled */}
          <button
            onClick={handleForceRefresh}
            style={{
              background: 'transparent',
              border: '1px solid #374151',
              borderRadius: 6,
              padding: '8px 16px',
              color: '#e2e8f0',
              fontSize: 13,
              cursor: 'pointer',
              transition: 'border-color 150ms',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#3b82f6')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#374151')}
          >
            Force Refresh World Data
          </button>

          {/* Clear All Caches — disabled */}
          <div style={{ position: 'relative' }}>
            <button
              disabled
              title="Coming soon"
              style={{
                background: 'transparent',
                border: '1px solid #1e2128',
                borderRadius: 6,
                padding: '8px 16px',
                color: '#374151',
                fontSize: 13,
                cursor: 'not-allowed',
              }}
            >
              Clear All Caches
            </button>
            <span
              style={{
                position: 'absolute',
                top: -8,
                right: -8,
                background: '#1c1e23',
                border: '1px solid #25282e',
                borderRadius: 4,
                fontSize: 9,
                color: '#6b7280',
                padding: '1px 5px',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                pointerEvents: 'none',
              }}
            >
              Soon
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FundChip — removable ticker chip
// ---------------------------------------------------------------------------
function FundChip({ ticker, onRemove }) {
  const [hoverX, setHoverX] = useState(false);

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: '#1c1e23',
        border: '1px solid #25282e',
        borderRadius: 6,
        padding: '4px 8px 4px 10px',
      }}
    >
      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          color: '#e2e8f0',
        }}
      >
        {ticker}
      </span>
      <button
        onClick={onRemove}
        onMouseEnter={() => setHoverX(true)}
        onMouseLeave={() => setHoverX(false)}
        style={{
          background: 'none',
          border: 'none',
          color: hoverX ? '#ef4444' : '#6b7280',
          cursor: 'pointer',
          padding: '0 2px',
          lineHeight: 1,
          fontSize: 15,
          transition: 'color 120ms',
          display: 'flex',
          alignItems: 'center',
        }}
        title={`Remove ${ticker}`}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignOutButton — isolated so hover state is self-contained
// ---------------------------------------------------------------------------
function SignOutButton() {
  const [hover, setHover] = useState(false);

  return (
    <button
      onClick={() => supabase.auth.signOut()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'transparent',
        border: `1px solid ${hover ? '#ef4444' : '#374151'}`,
        borderRadius: 6,
        padding: '8px 16px',
        color: hover ? '#ef4444' : '#9ca3af',
        fontSize: 13,
        cursor: 'pointer',
        transition: 'color 150ms, border-color 150ms',
      }}
    >
      Sign Out
    </button>
  );
}
