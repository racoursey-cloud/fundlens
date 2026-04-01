// src/App.jsx
// Root application component.
// Handles three states: loading (checking session), unauthenticated, authenticated.
// Auth is confirmed via supabase.auth.getSession() BEFORE any data fetch.
// This prevents the v4 race condition where Supabase queries fired before
// the auth token was restored, routing users back to the setup wizard.

import { useEffect, useState } from 'react';
import { supabase }   from './services/supabase.js';
import useAppStore    from './store/useAppStore.js';

import LoginPage   from './components/auth/LoginPage.jsx';
import SetupWizard from './components/wizard/SetupWizard.jsx';
import AppShell    from './components/layout/AppShell.jsx';

// ─── supaFetch helper ─────────────────────────────────────────────────────────
// Used here only for the profile check on mount.
// Mirrors the PostgREST GET pattern in api.js.
async function supaFetch(path, options = {}) {
  const res = await fetch(`/api/supabase${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`supaFetch ${path} → ${res.status}: ${text}`);
  }
  // 204 No Content
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return res.json();
}

// ─── Loading spinner ──────────────────────────────────────────────────────────
// Shown while getSession() is in-flight. Blocks ALL rendering so no child
// component fires a Supabase or API query before auth is confirmed.
const LoadingScreen = () => (
  <div style={{
    position:       'fixed',
    inset:          0,
    background:     '#0e0f11',
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '20px',
  }}>
    <div style={{
      width:          '36px',
      height:         '36px',
      border:         '3px solid #25282e',
      borderTopColor: '#3b82f6',
      borderRadius:   '50%',
      animation:      'fl-spin 0.75s linear infinite',
    }} />
    <span style={{
      color:       '#6b7280',
      fontSize:    '13px',
      fontFamily:  'Inter, sans-serif',
      letterSpacing: '0.02em',
    }}>
      Loading…
    </span>
    <style>{`
      @keyframes fl-spin {
        to { transform: rotate(360deg); }
      }
    `}</style>
  </div>
);

// ─── Root component ───────────────────────────────────────────────────────────
export default function App() {
  const [loading,    setLoading]    = useState(true);
  const [session,    setSession]    = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  // ── Profile check ──────────────────────────────────────────────────────────
  // Fetches the user's profiles row. If absent or name is blank, routes to
  // SetupWizard. Errors fall through to SetupWizard (safe default).
  const checkProfile = async (user) => {
    try {
      const rows = await supaFetch(`/profiles?id=eq.${user.id}`);
      const profile = Array.isArray(rows) ? rows[0] : null;
      const hasName = profile?.name && profile.name.trim().length > 0;
      setNeedsSetup(!hasName);

      // Populate the store so every tab has user data before it renders.
      // Only call when the profile is complete (no point seeding a partial user).
      if (hasName) {
        await useAppStore.getState().initUser(user);
      }
    } catch (err) {
      console.error('[App] profile check failed:', err);
      setNeedsSetup(true);
    }
  };

  // ── Mount: resolve session FIRST, then profile ────────────────────────────
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const { data: { session: existingSession } } = await supabase.auth.getSession();

        if (!mounted) return;

        setSession(existingSession);

        if (existingSession?.user) {
          await checkProfile(existingSession.user);
        }
      } catch (err) {
        console.error('[App] getSession failed:', err);
        if (mounted) setSession(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

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
  // Re-checks profile after wizard saves so we confirm name exists before
  // advancing to AppShell. Also seeds the store now that setup is done.
  const onSetupComplete = async () => {
    if (session?.user) {
      await checkProfile(session.user);
    } else {
      setNeedsSetup(false);
    }
  };

  // ── Render gate ────────────────────────────────────────────────────────────
  if (loading)    return <LoadingScreen />;
  if (!session)   return <LoginPage />;
  if (needsSetup) return (
    <SetupWizard
      userId={session.user.id}
      onComplete={onSetupComplete}
    />
  );

  return <AppShell />;
}
