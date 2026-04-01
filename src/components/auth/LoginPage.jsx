// src/components/auth/LoginPage.jsx
// Passwordless magic-link login. Supabase handles the redirect callback automatically.
// App.jsx detects the resulting session via onAuthStateChange.

import { useState } from 'react';
import { supabase } from '../../services/supabase';

export default function LoginPage() {
  const [email, setEmail]     = useState('');
  const [status, setStatus]   = useState('idle'); // idle | loading | success | error
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async () => {
    const trimmed = email.trim();

    // Basic client-side validation
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErrorMsg('Invalid email address.');
      setStatus('error');
      return;
    }

    setStatus('loading');
    setErrorMsg('');

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { emailRedirectTo: window.location.origin },
    });

    if (error) {
      const msg = error.message?.toLowerCase().includes('rate')
        ? 'Too many requests — please wait a moment and try again.'
        : error.message || 'Something went wrong. Please try again.';
      setErrorMsg(msg);
      setStatus('error');
    } else {
      setStatus('success');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && status !== 'loading') handleSubmit();
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#0e0f11',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', sans-serif",
        padding: '24px',
      }}
    >
      {/* Card */}
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          backgroundColor: '#16181c',
          border: '1px solid #25282e',
          borderRadius: '16px',
          padding: '40px 36px 36px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '6px' }}>
          <span
            style={{
              fontSize: '24px',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '-0.5px',
            }}
          >
            Fund
          </span>
          <span
            style={{
              fontSize: '24px',
              fontWeight: 700,
              color: '#3b82f6',
              letterSpacing: '-0.5px',
            }}
          >
            Lens
          </span>
        </div>

        {/* Tagline */}
        <p
          style={{
            textAlign: 'center',
            fontSize: '13px',
            color: '#6b7280',
            margin: '0 0 24px',
          }}
        >
          401K Intelligence Platform
        </p>

        {/* Divider */}
        <div
          style={{
            height: '1px',
            backgroundColor: '#25282e',
            marginBottom: '28px',
          }}
        />

        {/* Form or Success */}
        {status === 'success' ? (
          <p
            style={{
              textAlign: 'center',
              fontSize: '14px',
              color: '#059669',
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            Check your email — we sent you a login link.
          </p>
        ) : (
          <>
            {/* Email input */}
            <div style={{ marginBottom: '14px' }}>
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (status === 'error') { setStatus('idle'); setErrorMsg(''); }
                }}
                onKeyDown={handleKeyDown}
                placeholder="your@email.com"
                disabled={status === 'loading'}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  backgroundColor: '#0e0f11',
                  border: `1px solid ${status === 'error' ? '#ef4444' : '#25282e'}`,
                  borderRadius: '8px',
                  color: '#ffffff',
                  fontSize: '14px',
                  padding: '11px 14px',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                  fontFamily: "'Inter', sans-serif",
                }}
                onFocus={(e) => {
                  if (status !== 'error') e.target.style.borderColor = '#3b82f6';
                }}
                onBlur={(e) => {
                  if (status !== 'error') e.target.style.borderColor = '#25282e';
                }}
              />
            </div>

            {/* Error message */}
            {status === 'error' && errorMsg && (
              <p
                style={{
                  fontSize: '12px',
                  color: '#ef4444',
                  margin: '0 0 12px',
                  lineHeight: 1.5,
                }}
              >
                {errorMsg}
              </p>
            )}

            {/* Submit button */}
            <button
              onClick={handleSubmit}
              disabled={status === 'loading'}
              style={{
                width: '100%',
                backgroundColor: status === 'loading' ? '#2563eb' : '#3b82f6',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '14px',
                fontFamily: "'Inter', sans-serif",
                border: 'none',
                borderRadius: '8px',
                padding: '12px',
                cursor: status === 'loading' ? 'not-allowed' : 'pointer',
                opacity: status === 'loading' ? 0.8 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                transition: 'background-color 0.15s, opacity 0.15s',
              }}
              onMouseEnter={(e) => {
                if (status !== 'loading') e.currentTarget.style.backgroundColor = '#2563eb';
              }}
              onMouseLeave={(e) => {
                if (status !== 'loading') e.currentTarget.style.backgroundColor = '#3b82f6';
              }}
            >
              {status === 'loading' ? (
                <>
                  <Spinner />
                  Sending...
                </>
              ) : (
                'Send Magic Link'
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Inline SVG spinner — no icon library needed
function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={{ animation: 'fundlens-spin 0.75s linear infinite' }}
    >
      <style>{`@keyframes fundlens-spin { to { transform: rotate(360deg); } }`}</style>
      <circle
        cx="8" cy="8" r="6"
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="2"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
