import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api.js';

// Brand CI: #0D1B3E navy · #C9A84C gold · Cormorant Garamond heading

const PAD_KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

export default function LoginScreen() {
  const [pin, setPin]   = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  function press(k) {
    setError('');
    if (k === '⌫') { setPin(p => p.slice(0, -1)); return; }
    if (k === '')  return;
    if (pin.length >= 8) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 6) submit(next);
  }

  async function submit(pinToUse) {
    const p = pinToUse ?? pin;
    if (!p) return;
    setBusy(true); setError('');
    try {
      const { token, staff } = await api.post('/auth/login', { pin: p });
      setAuth({ token, staff });
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message || 'Login failed');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key >= '0' && e.key <= '9') press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') submit();
  }

  return (
    <div
      onKeyDown={onKeyDown}
      tabIndex={0}
      style={{
        minHeight: '100vh',
        minHeight: '100dvh',          /* iOS safe area */
        background: '#0D1B3E',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        outline: 'none',
      }}
    >
      {/* ── Lotus badge + wordmark ──────────────────────────────── */}
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <svg
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
          style={{ width: 72, height: 72, display: 'block', margin: '0 auto 16px' }}
          aria-label="SiamEPOS Spa logo"
        >
          <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8"/>
          <circle cx="50" cy="50" r="39" fill="none" stroke="#C9A84C" strokeWidth="0.6" opacity="0.28"/>
          <g transform="translate(50,50)">
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
            <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
            <circle cx="0" cy="0" r="9" fill="#0D1B3E"/>
            <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
          </g>
        </svg>

        {/* Cormorant Garamond wordmark — brand CI heading font */}
        <div style={{
          fontFamily: "'Cormorant Garamond', Georgia, serif",
          fontSize: 40, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1,
        }}>
          <span style={{ color: 'white' }}>Siam</span>
          <span style={{ color: '#C9A84C' }}>EPOS</span>
        </div>

        <div style={{
          color: 'rgba(201,168,76,0.75)',
          fontSize: 12, marginTop: 8,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
        }}>
          Spa · Staff Login
        </div>
      </div>

      {/* ── PIN card ────────────────────────────────────────────── */}
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(201,168,76,0.25)',
        borderRadius: 20,
        padding: '28px 24px 24px',
        width: '100%',
        maxWidth: 340,
      }}>

        {/* PIN dots */}
        <div style={{
          height: 32, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 10, marginBottom: 20,
        }}>
          {pin.length === 0 ? (
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 14, letterSpacing: '0.05em', fontFamily: 'Inter, sans-serif' }}>
              Enter your PIN
            </span>
          ) : (
            Array.from({ length: pin.length }).map((_, i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: '50%', background: '#C9A84C',
                boxShadow: '0 0 8px rgba(201,168,76,0.55)',
              }} />
            ))
          )}
        </div>

        {/* Error — fixed-height slot so numpad never shifts */}
        <div style={{ height: 38, marginBottom: 16 }}>
          {error && (
            <div style={{
              background: 'rgba(239,68,68,0.14)',
              border: '1px solid rgba(239,68,68,0.35)',
              color: '#fca5a5',
              borderRadius: 8, padding: '9px 14px',
              fontSize: 13, textAlign: 'center',
              fontWeight: 500, fontFamily: 'Inter, sans-serif',
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Numpad — 56px min-height for touch */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
          {PAD_KEYS.map((k, i) => {
            if (k === '') return <div key={i} />;
            const isDel = k === '⌫';
            return (
              <button
                key={i}
                onClick={() => !busy && press(k)}
                disabled={busy}
                style={{
                  height: 60,
                  borderRadius: 12,
                  border: isDel ? '1px solid rgba(239,68,68,0.25)' : '1px solid rgba(255,255,255,0.10)',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  background: isDel ? 'rgba(239,68,68,0.10)' : 'rgba(255,255,255,0.08)',
                  color: isDel ? '#fca5a5' : 'white',
                  fontSize: isDel ? 20 : 24,
                  fontWeight: 700,
                  transition: 'background 0.1s, transform 0.07s',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  WebkitTapHighlightColor: 'transparent',
                }}
                onMouseDown={e => { if (!busy) e.currentTarget.style.transform = 'scale(0.93)'; }}
                onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                onTouchStart={e => { if (!busy) e.currentTarget.style.background = 'rgba(201,168,76,0.18)'; }}
                onTouchEnd={e => { e.currentTarget.style.background = isDel ? 'rgba(239,68,68,0.10)' : 'rgba(255,255,255,0.08)'; }}
              >
                {k}
              </button>
            );
          })}
        </div>

        {/* Sign in */}
        <button
          onClick={() => submit()}
          disabled={busy || !pin}
          style={{
            width: '100%', height: 56, borderRadius: 12, border: 'none',
            background: busy        ? 'rgba(255,255,255,0.08)'
                      : pin.length  ? '#C9A84C'
                      : 'rgba(255,255,255,0.06)',
            color: pin.length && !busy ? '#0D1B3E' : 'rgba(255,255,255,0.28)',
            fontSize: 16, fontWeight: 800,
            cursor: pin.length && !busy ? 'pointer' : 'default',
            transition: 'background 0.15s',
            letterSpacing: '0.04em',
            fontFamily: 'Inter, sans-serif',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 32, color: 'rgba(201,168,76,0.35)',
        fontSize: 12, textAlign: 'center', letterSpacing: '0.05em',
        fontFamily: 'Inter, sans-serif',
      }}>
        siamepos.co.uk
      </div>
    </div>
  );
}
