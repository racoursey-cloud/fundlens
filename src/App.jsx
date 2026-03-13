import { useState, useEffect } from 'react';
import { supabase } from './services/supabase.js';
import { useAppStore } from './store/useAppStore.js';
import LoginPage from './components/auth/LoginPage.jsx';
import SetupWizard from './components/wizard/SetupWizard.jsx';
import AppShell from './components/layout/AppShell.jsx';

// Race a promise against a timeout — resolves to fallback if the promise hangs
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export default function App() {
  const setUser        = useAppStore(s => s.setUser);
  const setProfile     = useAppStore(s => s.setProfile);
  const setUserFunds   = useAppStore(s => s.setUserFunds);
  const setUserWeights = useAppStore(s => s.setUserWeights);
  const profile        = useAppStore(s => s.profile);
  const userFunds      = useAppStore(s => s.userFunds);

  const [session,     setSession]     = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [authError,   setAuthError]   = useState(null);

  const loadUserData = async (userId) => {
    setDataLoading(true);
    try {
      // Run each query individually with logging so we can see which one hangs
      console.log('[App] loadUserData: fetching profiles...');
      const profileRes = await withTimeout(
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
        8000,
        { data: null, error: { message: 'profiles query timed out' } }
      );
      if (profileRes.error) console.warn('[App] profiles error:', profileRes.error.message);
      else console.log('[App] profiles OK');

      console.log('[App] loadUserData: fetching user_funds...');
      const fundsRes = await withTimeout(
        supabase.from('user_funds').select('*').eq('user_id', userId).order('sort_order'),
        8000,
        { data: [], error: { message: 'user_funds query timed out' } }
      );
      if (fundsRes.error) console.warn('[App] user_funds error:', fundsRes.error.message);
      else console.log('[App] user_funds OK:', (fundsRes.data || []).length, 'rows');

      console.log('[App] loadUserData: fetching user_weights...');
      const weightsRes = await withTimeout(
        supabase.from('user_weights').select('*').eq('user_id', userId).maybeSingle(),
        8000,
        { data: null, error: { message: 'user_weights query timed out' } }
      );
      if (weightsRes.error) console.warn('[App] user_weights error:', weightsRes.error.message);
      else console.log('[App] user_weights OK');

      setProfile(profileRes.data   || null);
      setUserFunds(fundsRes.data   || []);
      setUserWeights(weightsRes.data || null);
    } catch (e) {
      console.error('[App] loadUserData error:', e);
    }
    setDataLoading(false);
  };

  useEffect(() => {
    // Handle Supabase auth redirect hash errors (e.g. expired OTP link)
    const hash = window.location.hash;
    if (hash.includes('error=')) {
      const params = new URLSearchParams(hash.replace('#', ''));
      const desc = params.get('error_description') || 'Authentication error';
      setAuthError(desc.replace(/\+/g, ' '));
      window.history.replaceState(null, '', window.location.pathname);
      setAuthLoading(false);
      return;
    }

    // Normal session boot — 5s timeout so the app never hangs
    console.log('[App] Calling getSession...');
    const TIMEOUT_FALLBACK = { data: { session: null } };

    withTimeout(supabase.auth.getSession(), 5000, TIMEOUT_FALLBACK)
      .then(async ({ data: { session: s } }) => {
        console.log('[App] getSession resolved, session:', s ? 'YES' : 'NO');
        setSession(s);
        setUser(s?.user ?? null);
        if (s?.user) await loadUserData(s.user.id);
        setAuthLoading(false);
      })
      .catch(err => {
        console.error('[App] getSession failed:', err);
        setAuthLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        await loadUserData(s.user.id);
      }
      if (event === 'SIGNED_OUT') {
        setProfile(null);
        setUserFunds([]);
        setUserWeights(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  if (authError) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', background:'var(--bg)', gap:'16px' }}>
        <div className="app-logo" style={{ fontSize:'22px' }}>Fund<span>Lens</span></div>
        <div style={{ background:'var(--surface)', border:'1px solid var(--danger,#e55)', borderRadius:'8px',
          padding:'24px 32px', maxWidth:'400px', textAlign:'center' }}>
          <p style={{ color:'var(--danger,#e55)', marginBottom:'12px', fontWeight:600 }}>Link Expired</p>
          <p style={{ color:'var(--text2)', fontSize:'13px', marginBottom:'20px' }}>{authError}</p>
          <button onClick={() => setAuthError(null)}
            style={{ background:'var(--accent)', color:'#fff', border:'none', borderRadius:'6px',
              padding:'10px 24px', cursor:'pointer', fontWeight:600 }}>
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  if (authLoading || dataLoading) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', background:'var(--bg)', gap:'16px' }}>
        <div className="app-logo" style={{ fontSize:'22px' }}>Fund<span>Lens</span></div>
        <span className="spinner" style={{ width:24, height:24, borderWidth:3 }} />
        <p style={{ fontSize:'12px', color:'var(--text3)' }}>{authLoading ? 'Checking session...' : 'Loading your profile...'}</p>
      </div>
    );
  }

  if (!session) return <LoginPage />;
  if (userFunds.length === 0) return <SetupWizard onComplete={loadUserData} />;
  return <AppShell userFunds={userFunds} profile={profile} onSettingsChange={loadUserData} />;
}
