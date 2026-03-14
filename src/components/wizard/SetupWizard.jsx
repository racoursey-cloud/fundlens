import { useState } from 'react';
import { supabase } from '../../services/supabase.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  COMPANY_CODES, DEFAULT_WEIGHTS, WIZARD_STEPS, WIZARD_FACTORS,
} from '../../engine/constants.js';

// ── Risk helpers (ported from v3) ─────────────────────────────────
function riskLabel(rt) {
  if (rt <= 1) return 'Very Conservative';
  if (rt <= 3) return 'Conservative';
  if (rt <= 4) return 'Moderate-Conservative';
  if (rt === 5) return 'Balanced';
  if (rt <= 6) return 'Moderate-Aggressive';
  if (rt <= 7) return 'Growth';
  if (rt <= 8) return 'Aggressive';
  return 'Very Aggressive';
}

function riskDescription(rt) {
  if (rt <= 2) return 'You prioritize protecting your money above all else. FundLens will recommend stable, low-volatility funds that aim to beat inflation without significant risk of loss.';
  if (rt <= 4) return 'You want steady growth while limiting downside risk. FundLens will balance return potential with stability, avoiding the most volatile funds.';
  if (rt === 5) return 'You want a true balance between growth and protection. FundLens will recommend a diversified allocation across both stable and higher-growth funds.';
  if (rt <= 7) return 'You lean toward growth and are comfortable with some volatility in exchange for stronger potential returns. FundLens will concentrate allocation in the top-performing opportunities.';
  return 'You prioritize maximum growth and accept the possibility of significant short-term losses. FundLens will aggressively concentrate your allocation in the statistical outliers with the highest composite scores.';
}

// ── Weight auto-normalizer (ported from v3 wizardNext step 3) ─────
function normalizeWeights(W) {
  const out = { ...W };
  const tot = Object.values(out).reduce((s, v) => s + v, 0);
  if (tot === 0) return { ...DEFAULT_WEIGHTS };
  Object.keys(out).forEach(k => { out[k] = Math.round(out[k] / tot * 100); });
  const diff = 100 - Object.values(out).reduce((s, v) => s + v, 0);
  if (diff !== 0) {
    const biggest = Object.entries(out).sort((a, b) => b[1] - a[1])[0][0];
    out[biggest] += diff;
  }
  return out;
}

export default function SetupWizard({ onComplete }) {
  const user    = useAppStore(s => s.user);
  const setUserFunds   = useAppStore(s => s.setUserFunds);
  const setUserWeights = useAppStore(s => s.setUserWeights);
  const setProfile     = useAppStore(s => s.setProfile);

  const [step, setStep] = useState(1);
  const TOTAL = 4;

  const [data, setData] = useState({
    name:        '',
    companyCode: '',
    companyName: '',
    funds:       [],
    weights:     { ...DEFAULT_WEIGHTS },
    risk:        5,
    codeError:   '',
  });
  const [tickerInput, setTickerInput] = useState('');
  const [tickerError, setTickerError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // ── Ticker add ────────────────────────────────────────────────
  const addTicker = () => {
    const t = tickerInput.trim().toUpperCase();
    if (!t) return;
    if (!/^[A-Z0-9]{1,6}$/.test(t)) { setTickerError('Tickers are 1–6 letters/numbers (e.g. FXAIX).'); return; }
    if (data.funds.find(f => f.ticker === t)) { setTickerError(`${t} is already in your list.`); return; }
    setData(d => ({ ...d, funds: [...d.funds, { ticker: t, name: t }] }));
    setTickerInput('');
    setTickerError('');
  };

  const removeFund = (ticker) => {
    setData(d => ({ ...d, funds: d.funds.filter(f => f.ticker !== ticker) }));
  };

  // ── Company code ───────────────────────────────────────────────
  const applyCode = () => {
    const code = (data.companyCode || '').toUpperCase().trim();
    if (!code) { setData(d => ({ ...d, codeError: 'Please enter a code.' })); return; }
    const entry = COMPANY_CODES[code];
    if (!entry) {
      setData(d => ({ ...d, codeError: `Code "${code}" not recognised. Check with your employer.`, companyName: '' }));
      return;
    }
    const existing = new Set(data.funds.map(f => f.ticker));
    const toAdd = entry.funds.filter(f => !existing.has(f.ticker));
    setData(d => ({ ...d, funds: [...d.funds, ...toAdd], companyName: entry.name, codeError: '' }));
  };

  // ── Step validation ───────────────────────────────────────────
  const handleNext = () => {
    if (step === 1 && !data.name.trim()) { alert('Please enter your name.'); return; }
    if (step === 2 && data.funds.length === 0) { alert('Please add at least one fund.'); return; }
    if (step === 3) {
      const tot = Object.values(data.weights).reduce((s, v) => s + v, 0);
      if (tot !== 100) {
        setData(d => ({ ...d, weights: normalizeWeights(d.weights) }));
      }
    }
    setStep(s => s + 1);
  };

  // ── Save to Supabase + complete ───────────────────────────────
  const handleFinish = async () => {
    setSaving(true); setSaveError('');
    try {
      const uid = user.id;
      const finalWeights = normalizeWeights(data.weights);

      // 1. Update profile (name + company)
      await supabase.from('profiles').upsert({
        id:           uid,
        name:         data.name.trim(),
        risk:         data.risk,
        company_code: data.companyCode || null,
        company_name: data.companyName || null,
      });

      // 2. Replace user_funds (clear then insert)
      await supabase.from('user_funds').delete().eq('user_id', uid);
      if (data.funds.length) {
        await supabase.from('user_funds').insert(
          data.funds.map((f, i) => ({
            user_id:    uid,
            ticker:     f.ticker,
            name:       f.name,
            sort_order: i,
          }))
        );
      }

      // 3. Upsert user_weights
      await supabase.from('user_weights').upsert({
        user_id:        uid,
        mandate_score:  finalWeights.mandateScore,
        momentum:       finalWeights.momentum,
        risk_adj:       finalWeights.riskAdj,
        manager_quality: finalWeights.managerQuality,
        risk_tolerance: data.risk,
      });

      // 4. Reload user data in parent (App.jsx calls loadUserData)
      await onComplete(uid);
    } catch (e) {
      setSaveError('Something went wrong saving your profile. Please try again.');
      console.error('Wizard save error:', e);
    }
    setSaving(false);
  };

  // ── Step bodies ───────────────────────────────────────────────
  const renderStep1 = () => (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <label className="label" style={{ display: 'block', marginBottom: '5px' }}>Your Name</label>
        <input
          type="text"
          placeholder="First name or full name"
          value={data.name}
          onChange={e => setData(d => ({ ...d, name: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && handleNext()}
          autoFocus
        />
      </div>
      <div>
        <label className="label" style={{ display: 'block', marginBottom: '5px' }}>
          Employer Code <span style={{ color: 'var(--text3)', fontWeight: 400, letterSpacing: 0 }}>(optional)</span>
        </label>
        <p className="note" style={{ marginBottom: '8px' }}>If your employer gave you a FundLens code, enter it to auto-load your 401K fund list.</p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            placeholder="e.g. TA26"
            value={data.companyCode}
            onChange={e => setData(d => ({ ...d, companyCode: e.target.value.toUpperCase(), codeError: '' }))}
            onKeyDown={e => e.key === 'Enter' && applyCode()}
            style={{ flex: 1 }}
          />
          <button className="btn btn-ghost btn-sm" onClick={applyCode} style={{ whiteSpace: 'nowrap' }}>
            Load Funds
          </button>
        </div>
        {data.codeError && <p style={{ fontSize: '11px', color: 'var(--red)', marginTop: '5px' }}>{data.codeError}</p>}
        {data.companyName && (
          <p style={{ fontSize: '11px', color: 'var(--green)', marginTop: '5px', fontWeight: 600 }}>
            {'\u2713'} {data.companyName} {'\u2014'} {data.funds.length} funds loaded
          </p>
        )}
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div>
      <p className="note" style={{ marginBottom: '16px' }}>
        Add funds from your 401K plan. Enter tickers one at a time, or use an employer code on the previous step.
      </p>
      {/* Add ticker input */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
        <input
          type="text"
          placeholder="Ticker symbol (e.g. FXAIX)"
          value={tickerInput}
          onChange={e => { setTickerInput(e.target.value.toUpperCase()); setTickerError(''); }}
          onKeyDown={e => e.key === 'Enter' && addTicker()}
          style={{ flex: 1 }}
        />
        <button className="btn btn-ghost btn-sm" onClick={addTicker} style={{ whiteSpace: 'nowrap' }}>
          + Add
        </button>
      </div>
      {tickerError && <p style={{ fontSize: '11px', color: 'var(--red)', marginBottom: '10px' }}>{tickerError}</p>}

      {/* Fund chip list */}
      {data.funds.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border2)', borderRadius: '8px',
          padding: '20px', textAlign: 'center',
        }}>
          <p className="note">No funds added yet. Enter a ticker above or use an employer code.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
          {data.funds.map(f => (
            <div key={f.ticker} className="fund-chip">
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>{f.ticker}</span>
              <span style={{ color: 'var(--text3)', fontSize: '11px', fontWeight: 400 }}>{f.name !== f.ticker ? f.name : ''}</span>
              <button onClick={() => removeFund(f.ticker)} title={`Remove ${f.ticker}`}>×</button>
            </div>
          ))}
        </div>
      )}
      {data.funds.length > 0 && (
        <p className="note" style={{ marginTop: '10px' }}>{data.funds.length} fund{data.funds.length !== 1 ? 's' : ''} in your universe</p>
      )}
    </div>
  );

  const renderStep3 = () => {
    const W = data.weights;
    const tot = Object.values(W).reduce((s, v) => s + v, 0);
    const rt = data.risk;
    return (
      <div>
        {/* Factor weights */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
            <p className="note">Drag each slider to set how much each factor influences ranking. We'll auto-balance them to 100%.</p>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: 700,
              color: tot === 100 ? 'var(--green)' : 'var(--amber)',
            }}>
              {tot}%
            </span>
          </div>

          {WIZARD_FACTORS.map(f => (
            <div key={f.key} style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600 }}>{f.emoji} {f.label}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: 700 }}>
                  {W[f.key]}%
                </span>
              </div>
              <p className="note" style={{ marginBottom: '5px' }}>{f.what}</p>
              <input
                type="range"
                min="0" max="60" step="5"
                value={W[f.key]}
                onChange={e => {
                  const val = parseInt(e.target.value);
                  setData(d => ({ ...d, weights: { ...d.weights, [f.key]: val } }));
                }}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
            </div>
          ))}
        </div>

        {/* Risk tolerance */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '20px' }}>
          <label className="label" style={{ display: 'block', marginBottom: '4px' }}>
            Risk Tolerance
            <span style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text)', marginLeft: '8px', textTransform: 'none', letterSpacing: 0, fontSize: '13px' }}>
              {rt}/9 {'\u2014'} {riskLabel(rt)}
            </span>
          </label>
          <p className="note" style={{ marginBottom: '8px', lineHeight: 1.5 }}>
            Controls how <em>concentrated</em> your allocation is {'\u2014'} not what ranks highest. Higher = more money into fewer top-ranked funds.
          </p>
          <input
            type="range" min="1" max="9" step="1"
            value={rt}
            onChange={e => setData(d => ({ ...d, risk: parseInt(e.target.value) }))}
            style={{ width: '100%', accentColor: 'var(--accent)', marginBottom: '6px' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text3)', marginBottom: '8px' }}>
            <span>1 {'\u2014'} Spread evenly</span><span>9 {'\u2014'} Concentrate in top picks</span>
          </div>
          <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '10px 12px', fontSize: '11px', color: 'var(--text2)', lineHeight: 1.5 }}>
            {riskDescription(rt)}
          </div>
        </div>
      </div>
    );
  };

  const renderStep4 = () => {
    const W = normalizeWeights(data.weights);
    const topFactor = WIZARD_FACTORS.slice().sort((a, b) => (W[b.key] || 0) - (W[a.key] || 0))[0];
    return (
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: '44px', marginBottom: '14px' }}>📊</div>
        <h2 style={{ fontFamily: "'Libre Baskerville', serif", fontSize: '20px', marginBottom: '8px' }}>
          You're all set, {data.name || 'there'}!
        </h2>
        <p style={{ fontSize: '12px', color: 'var(--text2)', lineHeight: 1.7, marginBottom: '18px' }}>
          FundLens will look inside each fund, read today's world, and surface the funds positioned for the next 30–90 days.{' '}
          <em>Not next year. Right now.</em>
        </p>
        <div style={{ background: 'var(--surface2)', borderRadius: '8px', padding: '16px', textAlign: 'left', fontSize: '12px', color: 'var(--text2)' }}>
          {[
            ['Funds', `${data.funds.length} funds`],
            data.companyName ? ['Company', data.companyName] : null,
            ['Most important to you', `${topFactor.emoji} ${topFactor.label} (${W[topFactor.key]}%)`],
            ['Risk / Concentration', `${data.risk}/9 \u2014 ${riskLabel(data.risk)}`],
          ].filter(Boolean).map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
              <span>{label}</span>
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>{value}</span>
            </div>
          ))}
          {WIZARD_FACTORS.map(f => (
            <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ color: 'var(--text3)' }}>{f.emoji} {f.label}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>{W[f.key]}%</span>
            </div>
          ))}
        </div>
        {saveError && (
          <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-bd)', color: 'var(--red)', borderRadius: '7px', padding: '10px 12px', fontSize: '12px', marginTop: '14px', textAlign: 'left' }}>
            {saveError}
          </div>
        )}
        <p className="note" style={{ marginTop: '12px' }}>You can adjust all of these at any time in the Settings tab.</p>
      </div>
    );
  };

  const stepBodies = [null, renderStep1, renderStep2, renderStep3, renderStep4];
  const dots = [1, 2, 3, 4].map(i => (
    <div key={i} className={`step-dot${i <= step ? ' on' : ''}`} />
  ));

  return (
    <div className="wizard-wrap">
      <div className="wizard-card fade-in">
        {/* Header */}
        <div className="wizard-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div className="app-logo">Fund<span>Lens</span></div>
            <div className="step-dots">{dots}</div>
          </div>
          <h1 style={{ fontFamily: "'Libre Baskerville', serif", fontSize: '20px', fontWeight: 700, marginBottom: '4px' }}>
            {WIZARD_STEPS.titles[step]}
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text2)' }}>{WIZARD_STEPS.subs[step]}</p>
        </div>

        {/* Body */}
        <div className="wizard-body">{stepBodies[step]()}</div>

        {/* Footer */}
        <div className="wizard-footer">
          <div>
            {step > 1
              ? <button className="btn btn-ghost" onClick={() => setStep(s => s - 1)}>{'\u2190'} Back</button>
              : <div />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{step} of {TOTAL}</span>
            {step < TOTAL
              ? <button className="btn btn-primary" onClick={handleNext}>Continue {'\u2192'}</button>
              : (
                <button className="btn btn-green" onClick={handleFinish} disabled={saving}>
                  {saving
                    ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving...</>
                    : '▶ Start Analysis'}
                </button>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
