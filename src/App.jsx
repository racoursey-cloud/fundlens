import { useState, useEffect } from 'react';
import { supabase } from './services/supabase.js';
import { useAppStore } from './store/useAppStore.js';
import LoginPage from './components/auth/LoginPage.jsx';
import SetupWizard from './components/wizard/SetupWizard.jsx';
import AppShell from './components/layout/AppShell.jsx';

export default function App() {
  const setUser        = useAppStore(s => s.setUser);
  const setProfile     = useAppStore(s => s.setProfile);
  const setUserFunds   = useAppStore(s => s.setUserFunds);
  const setUserWeights = useAppStore(s => s.setUserWeights);

  const [session,     setSession]      = useState(null);
  const [profile,     setLocalProfile] = useState(null);
  const [userFunds,   setLocalFunds]   = useState([]);
  const [authLoading, setAuthLoading]  = useState(true);
  const [dataLoading, setDataLoading]  = useState(false);

  const loadUserData = async (userId) => {
    setDataLoading(true);
    try {
      const [profileRes, fundsRes, weightsRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).single(),
        supabase.from('user_funds').select('*').eq('user_id', userId).order('sort_order'),
        supabase.from('user_weights').select('*').eq('user_id', userId).single(),
      ]);
      const prof  = profileRes.data  || null;
      const funds = fundsRes.data    || [];
      const wts   = weightsRes.data  || null;
      setLocalProfile(prof); setLocalFunds(funds);
      setProfile(prof); setUserFunds(funds); setUserWeights(wts);
    } catch (e) { console.error('loadUserData error:', e); }
    setDataLoading(false);
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s); setUser(s?.user ?? null);
      if (s?.user) await loadUserData(s.user.id);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s); setUser(s?.user ?? null);
      if (s?.user && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        await loadUserData(s.user.id);
      }
      if (event === 'SIGNED_OUT') {
        setLocalProfile(null); setLocalFunds([]);
        setProfile(null); setUserFunds([]); setUserWeights(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  if (authLoading || dataLoading) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'var(--bg)', gap:'16px' }}>
        <div className="app-logo" style={{ fontSize:'22px' }}>Fund<span>Lens</span></div>
        <span className="spinner" style={{ width:24, height:24, borderWidth:3 }} />
        <p style={{ fontSize:'12px', color:'var(--text3)' }}>{authLoading ? 'Checking session…' : 'Loading your profile…'}</p>
      </div>
    );
  }

  if (!session) return <LoginPage />;
  if (userFunds.length === 0) return <SetupWizard onComplete={loadUserData} />;
  return <AppShell userFunds={userFunds} profile={profile} onSettingsChange={loadUserData} />;
}
