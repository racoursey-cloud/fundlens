// src/components/wizard/SetupWizard.jsx
// Runs once for new users. 4 steps: Profile → Funds → Weights → Confirm.
// Props: { userId, onComplete }
// All Supabase writes via supaFetch / supaDelete from api.js.
// No localStorage. No direct Supabase SDK calls.

import { useState, useCallback, useRef } from 'react';
import { supaFetch, supaDelete } from '../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 4;

const RISK_LABELS = {
  1: 'Very Conservative',
  2: 'Very Conservative',
  3: 'Conservative',
  4: 'Moderate-Conservative',
  5: 'Balanced',
  6: 'Moderate-Aggressive',
  7: 'Growth',
  8: 'Aggressive',
  9: 'Very Aggressive',
};

const RISK_DESCRIPTIONS = {
  1: 'Prioritises capital preservation above all else. The allocation engine will favour stable, low-volatility funds and heavily penalise concentration.',
  2: 'Prioritises capital preservation with minimal equity exposure. Stable, income-oriented funds will score highest.',
  3: 'Modest growth potential with strong downside protection. Bond-heavy and diversified funds receive scoring preference.',
  4: 'Slightly more growth potential while keeping drawdowns limited. Balanced exposure with a tilt toward defensive equity.',
  5: 'Equal emphasis on growth and stability. Scores reward consistency and steady upward momentum across market conditions.',
  6: 'Growth-oriented with some tolerance for short-term volatility. The engine accepts moderate sector concentration.',
  7: 'Long-term capital appreciation is the priority. Sector concentration and momentum are rewarded over defensive positioning.',
  8: 'High equity concentration and momentum-chasing. Volatility is expected and accepted in pursuit of returns.',
  9: 'Maximum risk tolerance. The engine will favour breakaway performers and largely ignore defensive or income-oriented funds.',
};

const FACTOR_META = [
  {
    key: 'sectorAlignment',
    label: 'Positioning',
    description: "How well does the fund's sector exposure align with the current macro thesis?",
    defaultVal: 25,
  },
  {
    key: 'momentum',
    label: 'Momentum',
    description: "Is this fund's recent price performance strong relative to peers?",
    defaultVal: 40,
  },
  {
    key: 'holdingsQuality',
    label: 'Quality',
    description: 'How fundamentally sound are the underlying holdings?',
    defaultVal: 35,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (total === 0) return { sectorAlignment: 25, momentum: 40, holdingsQuality: 35 };
  const factor = 100 / total;
  return Object.fromEntries(
    Object.entries(weights).map(([k, v]) => [k, Math.round(v * factor)])
  );
}

function weightsTotal(weights) {
  return Object.values(weights).reduce((s, v) => s + v, 0);
}

function parseTickers(raw) {
  return raw
    .split(/[\s,;\n\r]+/)
    .map(t => t.trim().toUpperCase())
    .filter(t => t.length > 0 && /^[A-Z0-9]{1,10}$/.test(t));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepDots({ current }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 32 }}>
      {Array.from({ length: TOTAL_STEPS }, (_, i) => {
        const step = i + 1;
        const done = step < current;
        const active = step === current;
        return (
          <div
            key={step}
            style={{
              width: active ? 24 : 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: done
                ? '#3b82f6'
                : active
                ? '#3b82f6'
                : '#25282e',
              opacity: done ? 0.5 : 1,
              transition: 'all 0.2s ease',
            }}
          />
        );
      })}
    </div>
  );
}

function NavRow({ step, onBack, onNext, nextLabel = 'Next', nextDisabled = false, loading = false }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: step === 1 ? 'flex-end' : 'space-between',
        alignItems: 'center',
        marginTop: 28,
      }}
    >
      {step > 1 && (
        <button
          onClick={onBack}
          disabled={loading}
          style={{
            background: 'transparent',
            border: '1px solid #25282e',
            borderRadius: 8,
            color: '#9ca3af',
            fontSize: 14,
            padding: '10px 20px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          ← Back
        </button>
      )}
      <button
        onClick={onNext}
        disabled={nextDisabled || loading}
        style={{
          background: nextDisabled || loading ? '#1c1e23' : '#3b82f6',
          border: 'none',
          borderRadius: 8,
          color: nextDisabled || loading ? '#4b5563' : '#fff',
          fontSize: 14,
          fontWeight: 600,
          padding: '10px 24px',
          cursor: nextDisabled || loading ? 'not-allowed' : 'pointer',
          fontFamily: 'Inter, sans-serif',
          transition: 'background 0.15s ease',
          minWidth: 100,
        }}
      >
        {loading ? 'Saving…' : nextLabel}
      </button>
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.06em',
        color: '#6b7280',
        textTransform: 'uppercase',
        marginBottom: 8,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, style = {}, onPaste, disabled }) {
  return (
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      onPaste={onPaste}
      disabled={disabled}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: '#0e0f11',
        border: '1px solid #25282e',
        borderRadius: 8,
        color: '#e5e7eb',
        fontSize: 15,
        padding: '10px 14px',
        outline: 'none',
        fontFamily: 'Inter, sans-serif',
        ...style,
      }}
    />
  );
}

function FundChip({ ticker, onRemove }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: '#25282e',
        borderRadius: 6,
        padding: '4px 10px',
        color: '#e5e7eb',
      }}
    >
      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
          letterSpacing: '0.03em',
        }}
      >
        {ticker}
      </span>
      <button
        onClick={() => onRemove(ticker)}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#6b7280',
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1,
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
        }}
        aria-label={`Remove ${ticker}`}
      >
        ×
      </button>
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.1em',
        color: '#3b82f6',
        textTransform: 'uppercase',
        marginBottom: 6,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {children}
    </div>
  );
}

function StepHeading({ step, title, subtitle }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <SectionTitle>Step {step} of {TOTAL_STEPS}</SectionTitle>
      <h2
        style={{
          margin: '4px 0 6px',
          fontSize: 22,
          fontWeight: 700,
          color: '#f9fafb',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p style={{ margin: 0, fontSize: 14, color: '#6b7280', fontFamily: 'Inter, sans-serif' }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#25282e', margin: '20px 0' }} />;
}

// ---------------------------------------------------------------------------
// Step 1 — Your Profile
// ---------------------------------------------------------------------------

function Step1({ data, onChange }) {
  const { name, companyCodeInput, companyCodeStatus, companyName, companyFundCount, riskTolerance } = data;
  const [checking, setChecking] = useState(false);

  const handleApplyCode = useCallback(async () => {
    if (!companyCodeInput.trim()) return;
    setChecking(true);
    onChange('companyCodeStatus', 'loading');
    try {
      const rows = await supaFetch(
        `company_codes?code=eq.${encodeURIComponent(companyCodeInput.trim().toUpperCase())}`
      );
      if (rows && rows.length > 0) {
        const row = rows[0];
        onChange('companyCodeStatus', 'found');
        onChange('companyName', row.company_name || '');
        onChange('companyFundCount', (row.funds || []).length);
        onChange('companyFunds', row.funds || []);
        onChange('companyCode', companyCodeInput.trim().toUpperCase());
      } else {
        onChange('companyCodeStatus', 'not_found');
        onChange('companyName', '');
        onChange('companyFundCount', 0);
        onChange('companyFunds', []);
        onChange('companyCode', '');
      }
    } catch {
      onChange('companyCodeStatus', 'not_found');
    } finally {
      setChecking(false);
    }
  }, [companyCodeInput, onChange]);

  const rtLabel = RISK_LABELS[riskTolerance] || 'Balanced';
  const rtDesc = RISK_DESCRIPTIONS[riskTolerance] || '';

  return (
    <div>
      <StepHeading
        step={1}
        title="Your Profile"
        subtitle="Tell us a bit about yourself so we can personalise the analysis."
      />

      {/* Name */}
      <div style={{ marginBottom: 20 }}>
        <FieldLabel>Your name *</FieldLabel>
        <TextInput
          value={name}
          onChange={e => onChange('name', e.target.value)}
          placeholder="e.g. Alex Johnson"
        />
      </div>

      {/* Company Code */}
      <div style={{ marginBottom: 20 }}>
        <FieldLabel>Company code (optional)</FieldLabel>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput
            value={companyCodeInput}
            onChange={e => {
              onChange('companyCodeInput', e.target.value.toUpperCase());
              if (companyCodeStatus) onChange('companyCodeStatus', null);
            }}
            placeholder="e.g. ACME2025"
            style={{ flex: 1 }}
            disabled={checking}
          />
          <button
            onClick={handleApplyCode}
            disabled={!companyCodeInput.trim() || checking}
            style={{
              background: companyCodeInput.trim() && !checking ? '#3b82f6' : '#1c1e23',
              border: 'none',
              borderRadius: 8,
              color: companyCodeInput.trim() && !checking ? '#fff' : '#4b5563',
              fontSize: 14,
              fontWeight: 600,
              padding: '10px 18px',
              cursor: companyCodeInput.trim() && !checking ? 'pointer' : 'not-allowed',
              fontFamily: 'Inter, sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            {checking ? '…' : 'Apply'}
          </button>
        </div>
        {companyCodeStatus === 'found' && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 12px',
              background: 'rgba(5,150,105,0.1)',
              border: '1px solid rgba(5,150,105,0.3)',
              borderRadius: 6,
              color: '#34d399',
              fontSize: 13,
              fontFamily: 'Inter, sans-serif',
            }}
          >
            ✓ {companyName} — {companyFundCount} fund{companyFundCount !== 1 ? 's' : ''} loaded
          </div>
        )}
        {companyCodeStatus === 'not_found' && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 12px',
              background: 'rgba(220,38,38,0.1)',
              border: '1px solid rgba(220,38,38,0.3)',
              borderRadius: 6,
              color: '#f87171',
              fontSize: 13,
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Code not recognised
          </div>
        )}
      </div>

      <Divider />

      {/* Risk Tolerance */}
      <div>
        <FieldLabel>Risk tolerance</FieldLabel>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: '#f9fafb', fontFamily: 'Inter, sans-serif' }}>
            {riskTolerance} — {rtLabel}
          </span>
        </div>

        {/* Custom slider */}
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <input
            type="range"
            min={1}
            max={9}
            step={1}
            value={riskTolerance}
            onChange={e => onChange('riskTolerance', Number(e.target.value))}
            style={{
              width: '100%',
              WebkitAppearance: 'none',
              appearance: 'none',
              height: 6,
              borderRadius: 3,
              background: `linear-gradient(to right, #3b82f6 ${((riskTolerance - 1) / 8) * 100}%, #25282e ${((riskTolerance - 1) / 8) * 100}%)`,
              outline: 'none',
              cursor: 'pointer',
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
            <span
              key={n}
              style={{
                fontSize: 11,
                color: n === riskTolerance ? '#3b82f6' : '#4b5563',
                fontFamily: 'JetBrains Mono, monospace',
                fontWeight: n === riskTolerance ? 700 : 400,
              }}
            >
              {n}
            </span>
          ))}
        </div>

        <div
          style={{
            padding: '10px 14px',
            background: '#0e0f11',
            border: '1px solid #25282e',
            borderRadius: 8,
            fontSize: 13,
            color: '#9ca3af',
            lineHeight: 1.6,
            fontFamily: 'Inter, sans-serif',
          }}
        >
          {rtDesc}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Your Funds
// ---------------------------------------------------------------------------

function Step2({ data, onChange }) {
  const { funds, companyFunds } = data;
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  const addTickers = useCallback(
    (tickers) => {
      const existing = new Set(funds.map(f => f.ticker));
      const toAdd = tickers
        .filter(t => !existing.has(t))
        .map(t => ({ ticker: t }));
      if (toAdd.length > 0) {
        onChange('funds', [...funds, ...toAdd]);
      }
    },
    [funds, onChange]
  );

  const handleAdd = useCallback(() => {
    const val = input.trim().toUpperCase();
    if (!val) return;
    const tickers = parseTickers(val);
    if (tickers.length > 0) {
      addTickers(tickers);
      setInput('');
      inputRef.current?.focus();
    }
  }, [input, addTickers]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd]
  );

  const handlePaste = useCallback(
    (e) => {
      const pasted = e.clipboardData.getData('text');
      const tickers = parseTickers(pasted);
      if (tickers.length > 1) {
        e.preventDefault();
        addTickers(tickers);
        setInput('');
      }
    },
    [addTickers]
  );

  const handleRemove = useCallback(
    (ticker) => {
      onChange('funds', funds.filter(f => f.ticker !== ticker));
    },
    [funds, onChange]
  );

  const prePopulateCompany = useCallback(() => {
    const tickers = companyFunds.map(t =>
      typeof t === 'string' ? t : t.ticker
    );
    addTickers(tickers.map(t => t.toUpperCase()));
  }, [companyFunds, addTickers]);

  return (
    <div>
      <StepHeading
        step={2}
        title="Your Funds"
        subtitle="Add every fund available in your 401(k). FundLens will score and rank them."
      />

      {/* Company pre-populate banner */}
      {companyFunds && companyFunds.length > 0 && funds.length === 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.25)',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 13, color: '#93c5fd', fontFamily: 'Inter, sans-serif' }}>
            {companyFunds.length} funds available from your company plan
          </span>
          <button
            onClick={prePopulateCompany}
            style={{
              background: 'rgba(59,130,246,0.2)',
              border: '1px solid rgba(59,130,246,0.4)',
              borderRadius: 6,
              color: '#93c5fd',
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 12px',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            Load all
          </button>
        </div>
      )}

      {/* Add input */}
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Add fund ticker</FieldLabel>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            placeholder="e.g. FXAIX or paste a list…"
            onPaste={handlePaste}
            style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace' }}
          />
          <button
            onClick={handleAdd}
            disabled={!input.trim()}
            style={{
              background: input.trim() ? '#3b82f6' : '#1c1e23',
              border: 'none',
              borderRadius: 8,
              color: input.trim() ? '#fff' : '#4b5563',
              fontSize: 14,
              fontWeight: 600,
              padding: '10px 18px',
              cursor: input.trim() ? 'pointer' : 'not-allowed',
              fontFamily: 'Inter, sans-serif',
            }}
            // eslint-disable-next-line no-unused-expressions
            onKeyDown={handleKeyDown}
          >
            Add
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: '#4b5563', fontFamily: 'Inter, sans-serif' }}>
          You can also paste a comma- or newline-separated list (e.g. FXAIX, PRPFX, WEGRX)
        </div>
      </div>

      {/* Fund chips */}
      {funds.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            padding: '14px',
            background: '#0e0f11',
            border: '1px solid #25282e',
            borderRadius: 8,
            minHeight: 60,
            marginBottom: 12,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {funds.map(f => (
            <FundChip key={f.ticker} ticker={f.ticker} onRemove={handleRemove} />
          ))}
        </div>
      )}

      {funds.length === 0 && (
        <div
          style={{
            padding: '24px',
            background: '#0e0f11',
            border: '1px dashed #25282e',
            borderRadius: 8,
            textAlign: 'center',
            color: '#4b5563',
            fontSize: 13,
            fontFamily: 'Inter, sans-serif',
            marginBottom: 12,
          }}
        >
          No funds added yet — enter a ticker above or load from your company plan
        </div>
      )}

      <div style={{ fontSize: 13, color: '#6b7280', fontFamily: 'Inter, sans-serif' }}>
        <span style={{ color: funds.length > 0 ? '#e5e7eb' : '#4b5563', fontWeight: 600 }}>
          {funds.length}
        </span>{' '}
        fund{funds.length !== 1 ? 's' : ''} in your universe
        {funds.length === 0 && (
          <span style={{ color: '#ef4444', marginLeft: 8 }}>— at least 1 required</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — What Matters to You
// ---------------------------------------------------------------------------

function Step3({ data, onChange }) {
  const { weights } = data;
  const total = weightsTotal(weights);
  const isExact = total === 100;

  const handleWeight = (key, raw) => {
    const val = Math.max(0, Math.min(60, Number(raw)));
    onChange('weights', { ...weights, [key]: val });
  };

  return (
    <div>
      <StepHeading
        step={3}
        title="What Matters to You"
        subtitle="Adjust how much each factor influences the scoring. If they don't sum to 100, we'll auto-adjust when you proceed."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {FACTOR_META.map(({ key, label, description }) => {
          const val = weights[key] ?? 0;
          return (
            <div key={key}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                }}
              >
                <div>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#e5e7eb',
                      fontFamily: 'Inter, sans-serif',
                    }}
                  >
                    {label}
                  </span>
                  <div
                    style={{
                      fontSize: 12,
                      color: '#6b7280',
                      marginTop: 2,
                      fontFamily: 'Inter, sans-serif',
                    }}
                  >
                    {description}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: '#3b82f6',
                    fontFamily: 'JetBrains Mono, monospace',
                    minWidth: 44,
                    textAlign: 'right',
                  }}
                >
                  {val}%
                </span>
              </div>

              <input
                type="range"
                min={0}
                max={60}
                step={1}
                value={val}
                onChange={e => handleWeight(key, e.target.value)}
                style={{
                  width: '100%',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  height: 6,
                  borderRadius: 3,
                  background: `linear-gradient(to right, #3b82f6 ${(val / 60) * 100}%, #25282e ${(val / 60) * 100}%)`,
                  outline: 'none',
                  cursor: 'pointer',
                }}
              />
            </div>
          );
        })}
      </div>

      <Divider />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          background: isExact
            ? 'rgba(5,150,105,0.08)'
            : 'rgba(217,119,6,0.08)',
          border: `1px solid ${isExact ? 'rgba(5,150,105,0.3)' : 'rgba(217,119,6,0.3)'}`,
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 14, color: '#9ca3af', fontFamily: 'Inter, sans-serif' }}>
          Total
        </span>
        <span
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: isExact ? '#34d399' : '#fbbf24',
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          {total}%
          {!isExact && (
            <span
              style={{ fontSize: 12, fontWeight: 400, color: '#9ca3af', marginLeft: 8 }}
            >
              (will auto-adjust)
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Ready to Go
// ---------------------------------------------------------------------------

function WeightBar({ value }) {
  return (
    <div
      style={{
        height: 6,
        borderRadius: 3,
        background: '#25282e',
        overflow: 'hidden',
        flex: 1,
        marginLeft: 10,
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${(value / 60) * 100}%`,
          background: '#3b82f6',
          borderRadius: 3,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
}

function Step4({ data, saving, saveError }) {
  const { name, riskTolerance, funds, weights, companyName } = data;
  const displayWeights = normalizeWeights(weights);

  return (
    <div>
      <StepHeading
        step={4}
        title="Ready to Go"
        subtitle="Review your setup below, then start your first analysis."
      />

      {/* Summary cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        {/* Identity */}
        <div
          style={{
            padding: '14px 16px',
            background: '#0e0f11',
            border: '1px solid #25282e',
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Profile
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#f9fafb', fontFamily: 'Inter, sans-serif' }}>
            {name}
          </div>
          {companyName && (
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2, fontFamily: 'Inter, sans-serif' }}>
              {companyName}
            </div>
          )}
        </div>

        {/* Risk */}
        <div
          style={{
            padding: '14px 16px',
            background: '#0e0f11',
            border: '1px solid #25282e',
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Risk Level
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 20,
                fontWeight: 700,
                color: '#3b82f6',
              }}
            >
              {riskTolerance}
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#e5e7eb', fontFamily: 'Inter, sans-serif' }}>
              {RISK_LABELS[riskTolerance]}
            </span>
          </div>
        </div>

        {/* Funds */}
        <div
          style={{
            padding: '14px 16px',
            background: '#0e0f11',
            border: '1px solid #25282e',
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Fund Universe
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#f9fafb', fontFamily: 'Inter, sans-serif', marginBottom: 8 }}>
            {funds.length} fund{funds.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {funds.slice(0, 12).map(f => (
              <span
                key={f.ticker}
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  color: '#9ca3af',
                  background: '#25282e',
                  padding: '2px 8px',
                  borderRadius: 4,
                }}
              >
                {f.ticker}
              </span>
            ))}
            {funds.length > 12 && (
              <span style={{ fontSize: 11, color: '#6b7280', fontFamily: 'Inter, sans-serif', alignSelf: 'center' }}>
                +{funds.length - 12} more
              </span>
            )}
          </div>
        </div>

        {/* Weights */}
        <div
          style={{
            padding: '14px 16px',
            background: '#0e0f11',
            border: '1px solid #25282e',
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Scoring Weights
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {FACTOR_META.map(({ key, label }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center' }}>
                <span
                  style={{
                    width: 116,
                    fontSize: 12,
                    color: '#9ca3af',
                    fontFamily: 'Inter, sans-serif',
                    flexShrink: 0,
                  }}
                >
                  {label}
                </span>
                <WeightBar value={displayWeights[key] ?? 0} />
                <span
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#3b82f6',
                    marginLeft: 10,
                    width: 36,
                    textAlign: 'right',
                  }}
                >
                  {displayWeights[key]}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {saving && (
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.2)',
            borderRadius: 8,
            color: '#93c5fd',
            fontSize: 13,
            fontFamily: 'Inter, sans-serif',
            textAlign: 'center',
            marginBottom: 12,
          }}
        >
          Saving your profile…
        </div>
      )}

      {saveError && (
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(220,38,38,0.08)',
            border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: 8,
            color: '#f87171',
            fontSize: 13,
            fontFamily: 'Inter, sans-serif',
            marginBottom: 12,
          }}
        >
          {saveError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Wizard
// ---------------------------------------------------------------------------

export default function SetupWizard({ userId, onComplete }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Wizard data — single flat object for simplicity
  const [data, setData] = useState({
    name: '',
    companyCodeInput: '',
    companyCode: '',
    companyCodeStatus: null, // null | 'loading' | 'found' | 'not_found'
    companyName: '',
    companyFundCount: 0,
    companyFunds: [],
    riskTolerance: 5,
    funds: [],
    weights: { sectorAlignment: 25, momentum: 40, holdingsQuality: 35 },
  });

  const onChange = useCallback((key, value) => {
    setData(prev => ({ ...prev, [key]: value }));
  }, []);

  // Validation per step
  const canAdvance = () => {
    if (step === 1) return data.name.trim().length > 0;
    if (step === 2) return data.funds.length >= 1;
    if (step === 3) return true; // auto-normalize on advance
    if (step === 4) return true;
    return false;
  };

  const handleNext = async () => {
    if (!canAdvance()) return;

    if (step === 3) {
      // Auto-normalize weights before step 4
      const normalized = normalizeWeights(data.weights);
      setData(prev => ({ ...prev, weights: normalized }));
    }

    if (step === 4) {
      await handleSave();
      return;
    }

    setStep(s => s + 1);
  };

  const handleBack = () => {
    setSaveError('');
    setStep(s => Math.max(1, s - 1));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');

    try {
      const normalizedWeights = normalizeWeights(data.weights);

      // 1. Upsert profile
      await supaFetch('profiles', {
        method: 'POST',
        body: JSON.stringify({
          id: userId,
          name: data.name.trim(),
          company_name: data.companyName || null,
          company_code: data.companyCode || null,
          risk_tolerance: data.riskTolerance,
        }),
      });

      // 2. Upsert weights
      await supaFetch('user_weights', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          sector_alignment: normalizedWeights.sectorAlignment,
          momentum: normalizedWeights.momentum,
          holdings_quality: normalizedWeights.holdingsQuality,
          risk_tolerance: data.riskTolerance,
        }),
      });

      // 3. Delete existing user_funds, then insert fresh
      try {
        await supaFetch(`user_funds?user_id=eq.${userId}`, { method: 'DELETE' });
      } catch {
        // Table may be empty — not fatal
      }

      // 4. Insert funds sequentially
      for (let i = 0; i < data.funds.length; i++) {
        const f = data.funds[i];
        await supaFetch('user_funds', {
          method: 'POST',
          body: JSON.stringify({
            user_id: userId,
            ticker: f.ticker,
            name: f.name || f.ticker,
            sort_order: i,
          }),
        });
      }

      // 5. Done
      onComplete();
    } catch (err) {
      console.error('SetupWizard save error:', err);
      setSaveError('Something went wrong saving your profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const nextLabel = step === 4 ? 'Start Analysis' : 'Next →';

  return (
    <>
      {/* Slider thumb global style */}
      <style>{`
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #3b82f6;
          cursor: pointer;
          border: 2px solid #0e0f11;
          box-shadow: 0 0 0 2px rgba(59,130,246,0.3);
        }
        input[type=range]::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #3b82f6;
          cursor: pointer;
          border: 2px solid #0e0f11;
          box-shadow: 0 0 0 2px rgba(59,130,246,0.3);
        }
        input[type=range]:focus::-webkit-slider-thumb {
          box-shadow: 0 0 0 4px rgba(59,130,246,0.35);
        }
        *:focus { outline: none; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0e0f11; }
        ::-webkit-scrollbar-thumb { background: #25282e; border-radius: 3px; }
      `}</style>

      {/* Full-page backdrop */}
      <div
        style={{
          minHeight: '100vh',
          background: '#0e0f11',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 16px',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 560,
          }}
        >
          {/* Logo / brand mark */}
          <div
            style={{
              textAlign: 'center',
              marginBottom: 28,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: '#3b82f6',
                textTransform: 'uppercase',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              FundLens
            </span>
            <div
              style={{
                fontSize: 12,
                color: '#4b5563',
                marginTop: 2,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              401(k) Intelligence Platform
            </div>
          </div>

          {/* Card */}
          <div
            style={{
              background: '#16181c',
              border: '1px solid #25282e',
              borderRadius: 16,
              padding: '32px 32px 24px',
            }}
          >
            {step === 1 && <Step1 data={data} onChange={onChange} />}
            {step === 2 && <Step2 data={data} onChange={onChange} />}
            {step === 3 && <Step3 data={data} onChange={onChange} />}
            {step === 4 && (
              <Step4 data={{ ...data, weights: normalizeWeights(data.weights) }} saving={saving} saveError={saveError} />
            )}

            <NavRow
              step={step}
              onBack={handleBack}
              onNext={handleNext}
              nextLabel={nextLabel}
              nextDisabled={!canAdvance()}
              loading={saving}
            />

            <StepDots current={step} />
          </div>

          <div
            style={{
              textAlign: 'center',
              marginTop: 16,
              fontSize: 11,
              color: '#374151',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Your data is stored securely and never shared.
          </div>
        </div>
      </div>
    </>
  );
}
