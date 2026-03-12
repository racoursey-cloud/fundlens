import { useState } from 'react';
import { supabase } from '../../services/supabase.js';

export default function LoginPage() {
  const [mode, setMode]         = useState('login');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [name, setName]         = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [info, setInfo]         = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault(); setError(''); setInfo(''); setLoading(true);
    if (mode === 'login') {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) setError(err.message);
    } else {
      if (!name.trim()) { setError('Please enter your name.'); setLoading(false); return; }
      const { data, error: err } = await supabase.auth.signUp({ email, password });
      if (err) { setError(err.message); }
      else if (data?.user) {
        await supabase.from('profiles').update({ name: name.trim() }).eq('id', data.user.id);
        if (!data.session) { setInfo('Account created! Check your email to confirm, then log in.'); setMode('login'); }
      }
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 20px', background:'var(--bg)' }}>
      <div style={{ width:'100%', maxWidth:'400px' }}>
        <div style={{ textAlign:'center', marginBottom:'32px' }}>
          <div className="app-logo" style={{ fontSize:'24px', marginBottom:'6px' }}>Fund<span>Lens</span></div>
          <p style={{ fontSize:'13px', color:'var(--text3)' }}>401K Intelligence</p>
        </div>
        <div className="card fade-in" style={{ padding:'32px' }}>
          <h2 style={{ fontFamily:"'Libre Baskerville',serif", fontSize:'18px', fontWeight:700, marginBottom:'6px' }}>
            {mode==='login' ? 'Sign in to FundLens' : 'Create your account'}
          </h2>
          <p style={{ fontSize:'12px', color:'var(--text3)', marginBottom:'24px' }}>
            {mode==='login' ? 'Your analysis, your history, your settings — always here.' : 'Set up your profile once. Run analysis anytime.'}
          </p>
          {error && <div style={{ background:'var(--red-bg)', border:'1px solid var(--red-bd)', color:'var(--red)', borderRadius:'7px', padding:'10px 12px', fontSize:'12px', marginBottom:'16px' }}>{error}</div>}
          {info  && <div style={{ background:'var(--green-bg)', border:'1px solid var(--green-bd)', color:'var(--green)', borderRadius:'7px', padding:'10px 12px', fontSize:'12px', marginBottom:'16px' }}>{info}</div>}
          <form onSubmit={handleSubmit}>
            {mode==='signup' && (
              <div style={{ marginBottom:'14px' }}>
                <label className="label" style={{ display:'block', marginBottom:'5px' }}>Your Name</label>
                <input type="text" placeholder="First name or full name" value={name} onChange={e=>setName(e.target.value)} required />
              </div>
            )}
            <div style={{ marginBottom:'14px' }}>
              <label className="label" style={{ display:'block', marginBottom:'5px' }}>Email</label>
              <input type="email" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="email" />
            </div>
            <div style={{ marginBottom:'24px' }}>
              <label className="label" style={{ display:'block', marginBottom:'5px' }}>Password</label>
              <input type="password" placeholder={mode==='signup' ? 'Minimum 6 characters' : 'Your password'} value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} autoComplete={mode==='login'?'current-password':'new-password'} />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width:'100%', justifyContent:'center', padding:'11px' }} disabled={loading}>
              {loading ? <><span className="spinner" style={{ width:14, height:14, borderWidth:2 }} /> Working...</> : mode==='login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <div style={{ textAlign:'center', marginTop:'20px', fontSize:'12px', color:'var(--text3)' }}>
            {mode==='login' ? (<>Don't have an account?{' '}<button onClick={()=>{setMode('signup');setError('');setInfo('');}} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent)', fontWeight:600 }}>Sign up</button></>) : (<>Already have an account?{' '}<button onClick={()=>{setMode('login');setError('');setInfo('');}} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent)', fontWeight:600 }}>Sign in</button></>)}
          </div>
        </div>
        <p style={{ textAlign:'center', fontSize:'11px', color:'var(--text3)', marginTop:'20px' }}>FundLens is a private 401K analysis tool.</p>
      </div>
    </div>
  );
}
