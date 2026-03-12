import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore.js';
import { supabase } from '../../services/supabase.js';
import { SEED, getTierFromModZ } from '../../engine/constants.js';

const TABS = [
  { id:'rank', label:'Rankings' }, { id:'thesis', label:'Investment Case' },
  { id:'portfolio', label:'Portfolio' }, { id:'holdings', label:'Holdings' },
  { id:'matrix', label:'Matrix' }, { id:'history', label:'History' },
  { id:'settings', label:'Settings' },
];

export default function AppShell({ userFunds, profile }) {
  const activeTab = useAppStore(s => s.activeTab);
  const setTab    = useAppStore(s => s.setTab);
  const source    = useAppStore(s => s.source);
  const loading   = useAppStore(s => s.loading);
  const lastRun   = useAppStore(s => s.lastRun);

  const seedFunds = useMemo(() => userFunds.map(f => ({
    ...f, composite: SEED[f.ticker]?.composite ?? 5.0, tier: getTierFromModZ(0), modZ: 0,
  })).sort((a,b) => b.composite - a.composite), [userFunds]);

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)' }}>
      <header className="app-header">
        <div style={{ display:'flex', alignItems:'center', gap:'16px' }}>
          <div className="app-logo">Fund<span>Lens</span></div>
          {source==='live' && <span className="src-live">LIVE</span>}
          {source==='seed' && <span className="src-seed">SEED DATA</span>}
          {source==='loading' && <span className="src-partial">RUNNINGÃ¢ÂÂ¦</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
          {lastRun && <span style={{ fontSize:'11px', color:'var(--text3)' }}>Last run: {new Date(lastRun).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span>}
          {profile?.name && <span style={{ fontSize:'12px', color:'var(--text2)', fontWeight:600 }}>{profile.name}</span>}
          <button className="btn btn-primary" disabled={loading} onClick={() => alert('Pipeline coming in Phase 2!')}>
            {loading ? <><span className="spinner" style={{ width:14, height:14, borderWidth:2 }} /> AnalyzingÃ¢ÂÂ¦</> : 'Ã¢ÂÂ¶ Run Analysis'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>
      <div className="tabs">
        {TABS.map(t => <button key={t.id} data-label={t.label} className={`tab${activeTab===t.id?' on':''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <main style={{ padding:'24px', maxWidth:'1200px', margin:'0 auto' }}>
        {activeTab==='rank' && <RankingsPlaceholder funds={seedFunds} source={source} />}
        {activeTab==='thesis' && <Placeholder icon="Ã°ÂÂÂ°" title="Investment Thesis" msg="Run Analysis to generate your macro thesis and sector outlook." />}
        {activeTab==='portfolio' && <Placeholder icon="Ã°ÂÂ¥Â§" title="Portfolio Allocation" msg="Run Analysis to build a risk-adjusted allocation." />}
        {activeTab==='holdings' && <Placeholder icon="Ã°ÂÂÂ" title="Fund Holdings" msg="Run Analysis to load holdings from SEC EDGAR." />}
        {activeTab==='matrix' && <Placeholder icon="Ã¢ÂÂÃ¯Â¸Â" title="Factor Matrix" msg="Run Analysis to see all 4 factors side by side." />}
        {activeTab==='history' && <Placeholder icon="Ã°ÂÂÂ" title="Run History" msg="Your past analysis runs will appear here." />}
        {activeTab==='settings' && <SettingsPlaceholder profile={profile} userFunds={userFunds} />}
      </main>
    </div>
  );
}

function RankingsPlaceholder({ funds, source }) {
  if (!funds.length) return <Placeholder icon="Ã°ÂÂÂ" title="Rankings" msg="No funds yet. Go to Settings to add funds." />;
  return (
    <div className="card fade-in">
      <div className="card-header">
        <div><span style={{ fontFamily:"'Libre Baskerville',serif", fontWeight:700, fontSize:'15px' }}>Fund Rankings</span>{source==='seed' && <span className="note" style={{ marginLeft:'10px' }}>Showing seed scores Ã¢ÂÂ click Run Analysis for live scoring</span>}</div>
        <span className="note">{funds.length} funds</span>
      </div>
      <div style={{ overflowX:'auto' }}>
        <table className="data-table">
          <thead><tr><th>#</th><th>Fund</th><th>Ticker</th><th style={{ textAlign:'right' }}>Composite</th><th>Tier</th></tr></thead>
          <tbody>
            {funds.map((f,i) => (
              <tr key={f.ticker}>
                <td style={{ color:'var(--text3)', fontFamily:"'JetBrains Mono',monospace", fontSize:'11px' }}>{i+1}</td>
                <td style={{ fontWeight:600, maxWidth:'260px' }}><div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.name}</div></td>
                <td style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:'12px', color:'var(--text2)' }}>{f.ticker}</td>
                <td style={{ textAlign:'right' }}><span className="score-md">{f.composite.toFixed(1)}</span></td>
                <td><span className="badge" style={{ background:'var(--surface2)', color:'var(--text3)', border:'1px solid var(--border)', fontSize:'10px' }}>SEED</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Placeholder({ icon, title, msg }) {
  return (
    <div style={{ textAlign:'center', padding:'60px 20px' }}>
      <div style={{ fontSize:'40px', marginBottom:'14px' }}>{icon}</div>
      <h2 style={{ fontFamily:"'Libre Baskerville',serif", fontSize:'18px', marginBottom:'8px' }}>{title}</h2>
      <p style={{ fontSize:'13px', color:'var(--text3)', maxWidth:'360px', margin:'0 auto' }}>{msg}</p>
    </div>
  );
}

function SettingsPlaceholder({ profile, userFunds }) {
  return (
    <div style={{ maxWidth:'560px' }}>
      <div className="card">
        <div className="card-header"><span style={{ fontFamily:"'Libre Baskerville',serif", fontWeight:700 }}>Your Profile</span></div>
        <div className="card-body" style={{ fontSize:'13px' }}>
          {[['Name',profile?.name||'Ã¢ÂÂ'],['Company',profile?.company_name||'Ã¢ÂÂ'],['Funds',`${userFunds.length} fund${userFunds.length!==1?'s':''} in universe`]].map(([label,value])=>(
            <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid var(--bg)' }}>
              <span style={{ color:'var(--text3)', fontWeight:600 }}>{label}</span>
              <span style={{ fontWeight:600 }}>{value}</span>
            </div>
          ))}
          <p className="note" style={{ marginTop:'16px' }}>Full settings coming in Phase 4.</p>
        </div>
      </div>
    </div>
  );
}
