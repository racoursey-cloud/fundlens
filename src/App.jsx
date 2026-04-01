// src/App.jsx
// Root application component.
// Handles three states: loading (checking session), unauthenticated, authenticated.
// Auth is confirmed via supabase.auth.getSession() BEFORE any data fetch.
// This prevents the v4 race condition where Supabase queries fired before
// the auth token was restored, routing users back to the setup wizard.

import { useEffect, useState } from 'react';
import { supabase } from './services/supabase.js';

// ─── Lazy imports ─────────────────────────────────────────────────────────────
// These components are built in subsequent phases. Importing them here
// keeps the routing logic co-located and lets each component be swapped
// in without touching App.jsx again.
import LoginPage   from './components/auth/LoginPage.jsx';
import SetupWizard from './components/wizard/SetupWizard.jsx';

// ─── AppShell placeholder (replaced in Phase 3) ───────────────────────────────
// The real AppShell (with three-tab layout, pipeline overlay, etc.) is built
// in Phase 3. This stub lets auth routing work end-to-end in Phase 1.
const AppShell = () => (
  <div style={{ padding: '40px', color: '#9ca3af', textAlign: 'center' }}>
    <h1 style={{
      fontSize: '24px',
      fontWeight: '700',
      color: '#e5e7eb',
      marginBottom: '8px',
      fontFamily: 'Inter, sans-serif',
    }}>
      FundLens v5
    </h1>
    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: '14px' }}>
      App loaded. Pipeline and UI coming in Phase 2–3.
    </p>
    <button
      onClick={() => supabase.auth.signOut()}
      style={{
        marginTop: '20px',
        padding: '8px 16px',
        background: '#25282e',
        color: '#9ca3af',
        border: '1px solid #25282e',
        borderRadius: '6px',
        cursor: 'pointer',
        fontFamily: 'Inter, sans-serif',
        fontSize: '13px',
      }}
    >
      Sign Out
    </button>
  </div>
);

// ─── supaFetch helper ─────────────────────────────────────────────────────────
// Mirrors the signature in cache.js. Used here only for the profile check
// on mount; all engine files import supaFetch from cache.js directly.
// When cache.js is available this import can replace the inline copy:
//   import { supaFetch } from './services/cache.js';
async function supaFetch(path, options = {}) {
  const res = await fetch(`/api/supabase${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`supaFetch ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Loading spinner ──────────────────────────────────────────────────────────
// Shown while getSession() is in-flight. Blocks ALL rendering so no child
// component fires a Supabase or API query before auth is confirmed.
const LoadingScreen = () => (
  <div style={{
    position: 'fixed',
    inset: 0,
    background: '#0e0f11',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '20px',
  }}>
    {/* Spinner */}
    <div style={{
      width: '36px',
      height: '36px',
      border: '3px solid #25282e',
      borderTopColor: '#3b82f6',
      borderRadius: '50%',
      animation: 'fl-spin 0.75s linear infinite',
    }} />
    <span style={{
      color: '#6b7280',
      fontSize: '13px',
      fontFamily: 'Inter, sans-serif',
      letterSpacing: '0.02em',
    }}>
      Loading…
    </span>

    {/* Keyframes injected once — no CSS-in-JS library required */}
    <style>{`
      @keyframes fl-spin {
        to { transform: rotate(360deg); }
      }
    `}</style>
  </div>
);

// ─── Root component ───────────────────────────────────────────────────────────
export default function App() {
  // true until getSession() resolves — gates ALL rendering
  const [loading,    setLoading]    = useState(true);
  // null = not logged in, object = Supabase session
  const [session,    setSession]    = useState(null);
  // true = profile missing or name absent → show SetupWizard
  const [needsSetup, setNeedsSetup] = useState(false);

  // ── Profile check ──────────────────────────────────────────────────────────
  // Called after session is confirmed. Fetches the user's row from
  // fund_profiles via the Railway proxy. If the row is absent or the name
  // field is empty the user must complete the setup wizard before the
  // main app is shown.
  const checkProfile = async (user) => {
    try {
      const rows = await supaFetch(`/profiles?id=eq.${user.id}`);
      const profile = Array.isArray(rows) ? rows[0] : null;
      const hasName = profile?.name && profile.name.trim().length > 0;
      setNeedsSetup(!hasName);
    } catch (err) {
      // If the profile fetch fails (e.g. network error on first load)
      // send the user through setup rather than dropping them into a
      // broken app state.
      console.error('[App] profile check failed:', err);
      setNeedsSetup(true);
    }
  };

  // ── Mount: resolve session FIRST, then profile ────────────────────────────
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        // RACE CONDITION FIX: getSession() must complete before ANY
        // downstream data fetch. The loading gate (loading === true)
        // ensures no child component renders — and therefore no API call
        // fires — until this promise resolves.
        const { data: { session: existingSession } } = await supabase.auth.getSession();

        if (!mounted) return;

        setSession(existingSession);

        if (existingSession?.user) {
          await checkProfile(existingSession.user);
        }
      } catch (err) {
        console.error('[App] getSession failed:', err);
        // Fall through to unauthenticated state
        if (mounted) setSession(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    // ── Auth state subscription ─────────────────────────────────────────────
    // Handles login (from LoginPage) and logout (from AppShell sign-out
    // button or session expiry). Does NOT re-enter the loading gate —
    // that is only for the initial mount check.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (!mounted) return;

        setSession(newSession);

        if (event === 'SIGNED_IN' && newSession?.user) {
          await checkProfile(newSession.user);
        }

        if (event === 'SIGNED_OUT') {
          setNeedsSetup(false);
        }
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── onSetupComplete ────────────────────────────────────────────────────────
  // Passed to SetupWizard. Called when the wizard saves the profile.
  // Re-fetches profile so we confirm the row now has a name before
  // advancing to AppShell.
  const onSetupComplete = async () => {
    if (session?.user) {
      await checkProfile(session.user);
    } else {
      setNeedsSetup(false);
    }
  };

  // ── Render gate ────────────────────────────────────────────────────────────
  // Nothing renders until auth is confirmed. This is the single source of
  // truth that prevents the v4 race condition.
  if (loading) return <LoadingScreen />;

  if (!session) return <LoginPage />;

  if (needsSetup) return <SetupWizard onComplete={onSetupComplete} />;

  return <AppShell />;
}
