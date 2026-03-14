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

// ── Supabase proxy query ──────────────────────────────────────────────────────
// Routes through /api/supabase (Railway proxy injects the service_role key).
// This bypasses RLS entirely and does NOT depend on the Supabase JS client's
// auth state. The old code used supabase.from(...) which attaches the user's
// JWT — on page reload that JWT is often expired and waiting for a background
// refresh, causing queries to hang until the 8s timeout fired. By the time
// onAuthStateChange refreshed the token, the app had already routed to the
// wizard because userFunds was [].
async function proxyQuery(path) {
  const res = await fetch(`/api/supabase${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase proxy ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
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

  // Load user data via the /api/supabase proxy (service_role key, bypasses RLS).
  // This is the same path every engine file uses via supaFetch() in cache.js.
  // The Supabase JS client is ONLY used for auth — never for table queries.
  const loadUserData = async (userId) => {
    setDataLoading(true);
    try {
      const uid = encodeURIComponent(userId);

      console.log('[App] loadUserData: fetching profiles via proxy...');
      const profileRows = await withTimeout(
        proxyQuery(`/profiles?id=eq.${uid}&limit=1`),
        15000,
        null
      );
      const profileData = Array.isArray(profileRows) && profileRows.length > 0
        ? profileRows[0]
        : null;
      console.log('[App] profiles:', profileData ? 'OK' : 'empty');

      console.log('[App] loadUserData: fetching user_funds via proxy...');
      const fundsRows = await withTimeout(
        proxyQuery(`/user_funds?user_id=eq.${uid}&order=sort_order`),
        15000,
        []
      );
      console.log('[App] user_funds:', (fundsRows || []).length, 'rows');

      console.log('[App] loadUserData: fetching user_weights via proxy...');
      const weightsRows = await withTimeout(
        proxyQuery(`/user_weights?user_id=eq.${uid}&limit=1`),
        15000,
        null
      );
      const weightsData = Array.isArray(weightsRows) && weightsRows.length > 0
        ? weightsRows[0]
        : null;
      console.log('[App] user_weights:', weightsData ? 'OK' : 'empty');

      setProfile(profileData);
      setUserFunds(fundsRows || []);
      setUserWeights(weightsData);
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

    // Normal session boot — 10s timeout so the app never hangs.
    // getSession() reads from localStorage first so it usually resolves fast,
    // but on slow networks the token-refresh round-trip can take a few seconds.
    // The old 5s timeout was too tight and caused false negatives on Railway.
    console.log('[App] Calling getSession...');
    const TIMEOUT_FALLBACK = { data: { session: null } };

    withTimeout(supabase.auth.getSession(), 10000, TIMEOUT_FALLBACK)
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
