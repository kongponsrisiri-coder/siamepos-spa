import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api.js';

// SEPOS-SPA-OWNER-001 v2 — owner remote login with email + password, matching
// the restaurant web-app login so both products work the same way.

const card = {
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(201,168,76,0.25)',
  borderRadius: 20, padding: '28px 24px', width: '100%', maxWidth: 360,
};
const field = {
  width: '100%', height: 52, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(255,255,255,0.08)', color: 'white', fontSize: 16, padding: '0 16px',
  fontFamily: 'system-ui, -apple-system, sans-serif', outline: 'none', marginBottom: 12,
};

export default function OwnerLoginScreen() {
  const navigate = useNavigate();
  const [email, setEmail]   = useState('');
  const [password, setPw]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');

  async function submit() {
    if (!email.includes('@') || !password) { setError('Enter your email and password.'); return; }
    setBusy(true); setError('');
    try {
      const { token, staff } = await api.post('/auth/email-login', { email: email.trim(), password });
      setAuth({ token, staff });
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message || 'Sign-in failed.');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: '100dvh', background: '#0D1B3E', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
         onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}>
      <div style={{ marginBottom: 28, textAlign: 'center' }}>
        <svg viewBox="0 0 100 100" style={{ width: 64, height: 64, display: 'block', margin: '0 auto 14px' }} aria-hidden="true">
          <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8" />
          <g transform="translate(50,50)">
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" />
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)" />
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)" />
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)" />
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)" />
            <circle cx="0" cy="0" r="9" fill="#0D1B3E" /><circle cx="0" cy="0" r="5" fill="#C9A84C" />
          </g>
        </svg>
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 36, fontWeight: 700, letterSpacing: '-0.5px' }}>
          <span style={{ color: 'white' }}>Siam</span><span style={{ color: '#C9A84C' }}>EPOS</span>
        </div>
        <div style={{ color: 'rgba(201,168,76,0.75)', fontSize: 12, marginTop: 8, letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 600 }}>
          Owner Sign-in
        </div>
      </div>

      <div style={card}>
        <input type="email" inputMode="email" autoFocus value={email}
          onChange={(e) => { setEmail(e.target.value); setError(''); }}
          placeholder="Email" style={field} />
        <input type="password" value={password}
          onChange={(e) => { setPw(e.target.value); setError(''); }}
          placeholder="Password" style={field} />
        {error && (
          <div style={{ margin: '2px 0 12px', background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5', borderRadius: 8, padding: '9px 14px', fontSize: 13, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
            {error}
          </div>
        )}
        <button onClick={submit} disabled={busy || !email || !password} style={{
          width: '100%', height: 52, borderRadius: 12, border: 'none',
          background: busy ? 'rgba(255,255,255,0.08)' : (email && password) ? '#C9A84C' : 'rgba(255,255,255,0.06)',
          color: (email && password && !busy) ? '#0D1B3E' : 'rgba(255,255,255,0.28)',
          fontWeight: 800, fontSize: 16, cursor: (email && password && !busy) ? 'pointer' : 'default',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>{busy ? 'Signing in…' : 'Sign In'}</button>
      </div>

      <a href="/login" style={{ marginTop: 24, color: 'rgba(201,168,76,0.7)', fontSize: 13, textDecoration: 'none', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        ← Staff login
      </a>
    </div>
  );
}
