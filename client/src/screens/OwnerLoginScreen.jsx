import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setAuth } from '../api.js';

// SEPOS-SPA-OWNER-001 — owner mobile sign-in (magic link).
// No token in the URL → show the "email me a link" form.
// ?token=… in the URL (from the emailed link) → verify it and sign in.

const Lotus = () => (
  <svg viewBox="0 0 100 100" style={{ width: 64, height: 64, display: 'block', margin: '0 auto 14px' }} aria-hidden="true">
    <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8" />
    <g transform="translate(50,50)">
      <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" />
      <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)" />
      <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)" />
      <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)" />
      <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)" />
      <circle cx="0" cy="0" r="9" fill="#0D1B3E" />
      <circle cx="0" cy="0" r="5" fill="#C9A84C" />
    </g>
  </svg>
);

const card = {
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(201,168,76,0.25)',
  borderRadius: 20, padding: '28px 24px', width: '100%', maxWidth: 360,
};
const inputStyle = {
  width: '100%', height: 52, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(255,255,255,0.08)', color: 'white', fontSize: 16, padding: '0 16px',
  fontFamily: 'system-ui, -apple-system, sans-serif', outline: 'none',
};
const goldBtn = (enabled) => ({
  width: '100%', height: 52, marginTop: 14, borderRadius: 12, border: 'none',
  background: enabled ? '#C9A84C' : 'rgba(255,255,255,0.08)',
  color: enabled ? '#0D1B3E' : 'rgba(255,255,255,0.4)', fontWeight: 800, fontSize: 16,
  cursor: enabled ? 'pointer' : 'default', fontFamily: 'system-ui, -apple-system, sans-serif',
});

export default function OwnerLoginScreen() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(!!token);

  // Verify the emailed link.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        const { token: jwt, staff } = await api.post('/auth/owner/verify', { token });
        if (!alive) return;
        setAuth({ token: jwt, staff });
        navigate('/', { replace: true });
      } catch (e) {
        if (!alive) return;
        setError(e.message || 'This sign-in link is invalid or has expired.');
        setVerifying(false);
      }
    })();
    return () => { alive = false; };
  }, [token]);

  async function requestLink() {
    if (!email.includes('@')) { setError('Please enter a valid email address.'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/auth/owner/request-link', { email: email.trim() });
      setSent(true);
    } catch (e) {
      setError(e.message || 'Something went wrong — please try again.');
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      minHeight: '100dvh', background: '#0D1B3E', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px 16px',
    }}>
      <div style={{ marginBottom: 28, textAlign: 'center' }}>
        <Lotus />
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 36, fontWeight: 700, letterSpacing: '-0.5px' }}>
          <span style={{ color: 'white' }}>Siam</span><span style={{ color: '#C9A84C' }}>EPOS</span>
        </div>
        <div style={{ color: 'rgba(201,168,76,0.75)', fontSize: 12, marginTop: 8, letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 600 }}>
          Owner Sign-in
        </div>
      </div>

      <div style={card}>
        {verifying ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.85)', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '12px 0' }}>
            Signing you in…
          </div>
        ) : sent ? (
          <div style={{ textAlign: 'center', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            <div style={{ fontSize: 30, marginBottom: 10 }}>✉️</div>
            <div style={{ color: 'white', fontWeight: 700, marginBottom: 6 }}>Check your email</div>
            <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 1.5 }}>
              If <strong style={{ color: '#C9A84C' }}>{email}</strong> is the registered owner email, a one-tap sign-in link is on its way. It expires in 15 minutes.
            </div>
          </div>
        ) : (
          <>
            <label style={{ display: 'block', color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 8, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
              Enter the owner email for this spa
            </label>
            <input
              type="email" inputMode="email" autoFocus value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && !busy && requestLink()}
              placeholder="you@yourspa.co.uk" style={inputStyle}
            />
            {error && (
              <div style={{ marginTop: 12, background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5', borderRadius: 8, padding: '9px 14px', fontSize: 13, textAlign: 'center', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
                {error}
              </div>
            )}
            <button onClick={requestLink} disabled={busy || !email} style={goldBtn(!!email && !busy)}>
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </>
        )}
        {verifying && error && (
          <div style={{ marginTop: 12, color: '#fca5a5', fontSize: 13, textAlign: 'center', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            {error} <a href="/owner-login" style={{ color: '#C9A84C' }}>Request a new link</a>
          </div>
        )}
      </div>

      <a href="/login" style={{ marginTop: 24, color: 'rgba(201,168,76,0.7)', fontSize: 13, textDecoration: 'none', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        ← Staff login
      </a>
    </div>
  );
}
