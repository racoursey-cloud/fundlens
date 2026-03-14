import { useState, useEffect, useCallback } from 'react';
import { supabase } from './services/supabase.js';
import { useAppStore } from './store/useAppStore.js';
import LoginPage from './components/auth/LoginPage.jsx';
import SetupWizard from './components/wizard/SetupWizard.jsx';
import AppShell from './components/layout/AppShell.jsx';

// ── Supabase proxy query ──────────────────────────────────────────────────────
// Routes through /api/supabase (Railway proxy injects the service_role key).
// This bypasses RLS entirely and does NOT depend on the Supabase JS client's
// auth state. The Supabase JS client is ONLY used for auth \u2014 never for
// table queries.
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

// Attempt a proxy query with a timeout. THROWS on timeout instead of returning
// a fallback \u2014 the caller must distinguish "no rows" from "query failed."
async function timedQuery(path, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Query timed out after ${ms}ms: ${path}`)), ms);
    proxyQuery(path)
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err   => { clearTimeout(timer); reject(err); });
  });
}

export default function App() {
  const setUser        = useAppStore(s => s.setUser);
  const setProfile     = useAppStore(s => s.setProfile);
  const setUserFunds   = useAppStore(s => s.setUserFunds);
  const setUserWeights = useAppStore(s => s.setUserWeights);
  const profile        = useAppStore(s => s.profile);
  const userFunds      = useAppStore(s => s.userFunds);

  const [session,      setSession]      = useState(null);
  const [authLoading,  setAuthLoading]  = useState(true);
  const [dataLoading,  setDataLoading]  = useState(false);
  const [dataLoaded,   setDataLoaded]   = useState(false);
  const [dataError,    setDataError]    = useState(null);
  const [authError,    setAuthError]    = useState(null);

  // Load user data via the /api/supabase proxy (service_role key, bypasses RLS).
  // Retries once on failure before surfacing an error. Never silently falls
  // through to the wizard \u2014 if data can't be loaded, the user sees a retry
  // screen instead.
  const loadUserData = useCallback(async (userId) => {
    setDataLoading(true);
    setDataError(null);
    setDataLoaded(false);

    const uid = encodeURIComponent(userId);
    const TIMEOUT = 15000;
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`[App] loadUserData attempt ${attempt}/${MAX_ATTEMPTS}...`);

        // Run all three queries in parallel \u2014 these go through the Railway
        // proxy with the service_role key, so they don't depend on the user's
        // JWT being refreshed yet.
        const [profileRows, fundsRows, weightsRows] = await Promise.all([
          timedQuery(`/profiles?id=eq.${uid}&limit=1`, TIMEOUT),
          timedQuery(`/user_funds?user_id=eq.${uid}&order=sort_order`, TIMEOUT),
          timedQuery(`/user_weights?user_id=eq.${uid}&limit=1`, TIMEOUT),
        ]);

        const profileData = Array.isArray(profileRows) && profileRows.length > 0
          ? profileRows[0]
          : null;
        const weightsData = Array.isArray(weightsRows) && weightsRows.length > 0
          ? weightsRows[0]
          : null;

        console.log('[App] profiles:', profileData ? 'OK' : 'empty');
        console.log('[App] user_funds:', (fundsRows || []).length, 'rows');
        console.log('[App] user_weights:', weightsData ? 'OK' : 'empty');

        setProfile(profileData);
        setUserFunds(fundsRows || []);
        setUserWeights(weightsData);
        setDataLoaded(true);
        setDataLoading(false);
        return; // success \u2014 exit the retry loop
      } catch (err) {
        console.warn(`[App] loadUserData attempt ${attempt} failed:`, err.message);
        if (attempt < MAX_ATTEMPTS) {
          // Wait 2s before retrying \u2014 gives Railway proxy time to warm up
          await new Promise(r => setTimeout(r, 2000));
        } else {
          // All attempts exhausted \u2014 surface the error
          console.error('[App] loadUserData failed after', MAX_ATTEMPTS, 'attempts');
          setDataError(err.message);
          setDataLoading(false);
          return;
        }
      }
    }
  }, [setProfile, setUserFunds, setUserWeights]);

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

    // Normal session boot.
    // getSession() reads from localStorage first so it usually resolves fast,
    // but on slow networks the token-refresh round-trip can take a few seconds.
    console.log('[App] Calling getSession...');

    const bootTimeout = setTimeout(() => {
      console.warn('[App] getSession timed out after 10s');
      setAuthLoading(false);
    }, 10000);

    supabase.auth.getSession()
      .then(async ({ data: { session: s } }) => {
        clearTimeout(bootTimeout);
        console.log('[App] getSession resolved, session:', s ? 'YES' : 'NO');
        setSession(s);
        setUser(s?.user ?? null);
        if (s?.user) await loadUserData(s.user.id);
        setAuthLoading(false);
      })
      .catch(err => {
        clearTimeout(bootTimeout);
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
        setDataLoaded(false);
        setDataError(null);
      }
    });

    return () => {
      clearTimeout(bootTimeout);
      subscription.unsubscribe();
    };
  }, []);

  // ── Auth error screen ─────────────────────────────────────────────────────
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

  // ── Loading spinner ───────────────────────────────────────────────────────
  if (authLoading || dataLoading) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', background:'var(--bg)', gap:'16px' }}>
        <div className="app-logo" style={{ fontSize:'22px' }}>Fund<span>Lens</span></div>
        <span className="spinner" style={{ width:24, height:24, borderWidth:3 }} />
        <p style={{ fontSize:'12px', color:'var(--text3)' }}>
          {authLoading ? 'Checking session...' : 'Loading your profile...'}
        </p>
      </div>
    );
  }

  // ── Data load error \u2014 retry screen instead of silent wizard redirect ───
  if (dataError && session) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', background:'var(--bg)', gap:'16px' }}>
        <div className="app-logo" style={{ fontSize:'22px' }}>Fund<span>Lens</span></div>
        <div style={{ background:'var(--surface)', border:'1px solid var(--border,#333)', borderRadius:'8px',
          padding:'24px 32px', maxWidth:'440px', textAlign:'center' }}>
          <p style={{ color:'var(--text1,#eee)', marginBottom:'8px', fontWeight:600 }}>
            Couldn{'\u2019'}t load your data
          </p>
          <p style={{ color:'var(--text3,#888)', fontSize:'13px', marginBottom:'20px' }}>
            The server took too long to respond. This usually resolves on a retry.
          </p>
          <div style={{ display:'flex', gap:'12px', justifyContent:'center' }}>
            <button onClick={() => loadUserData(session.user.id)}
              style={{ background:'var(--accent)', color:'#fff', border:'none', borderRadius:'6px',
                padding:'10px 24px', cursor:'pointer', fontWeight:600 }}>
              Try Again
            </button>
            <button onClick={async () => { await supabase.auth.signOut(); }}
              style={{ background:'transparent', color:'var(--text3,#888)', border:'1px solid var(--border,#333)',
                borderRadius:'6px', padding:'10px 24px', cursor:'pointer', fontWeight:500 }}>
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Routing ───────────────────────────────────────────────────────────────
  if (!session) return <LoginPage />;

  // CRITICAL: Only route to wizard if data was successfully loaded AND the
  // user genuinely has no funds. Without the dataLoaded guard, a failed
  // query (which leaves userFunds as []) would incorrectly show the wizard.
  if (dataLoaded && userFunds.length === 0) {
    return <SetupWizard onComplete={() => loadUserData(session.user.id)} />;
  }

  // If we have a session but data hasn't loaded yet (edge case: onAuthStateChange
  // fired before getSession completed), show the spinner.
  if (!dataLoaded) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', background:'var(--bg)', gap:'16px' }}>
        <div className="app-logo" style={{ fontSize:'22px' }}>Fund<span>Lens</span></div>
        <span className="spinner" style={{ width:24, height:24, borderWidth:3 }} />
        <p style={{ fontSize:'12px', color:'var(--text3)' }}>Loading your profile...</p>
      </div>
    );
  }

  return <AppShell userFunds={userFunds} profile={profile} onSettingsChange={() => loadUserData(session.user.id)} />;
}
