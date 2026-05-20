import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api.js';

// ── Sandy: LoginScreen — SiamEPOS Spa Brand CI ────────────────────
// Slate Navy #1e3a6e background · Thai Gold #C9A84C lotus + dots
// Georgia serif wordmark · Playfair Display heading

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
        background: '#1e3a6e',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        outline: 'none',
      }}
    >
      {/* ── Lotus badge + wordmark ──────────────────────────────── */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <svg
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
          style={{ width: 80, height: 80, display: 'block', margin: '0 auto 18px' }}
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
            <circle cx="0" cy="0" r="9" fill="#1e3a6e"/>
            <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
          </g>
        </svg>

        <div style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 38, fontWeight: 700, letterSpacing: '-1px', lineHeight: 1,
        }}>
          <span style={{ color: 'white' }}>Siam</span>
          <span style={{ color: '#C9A84C' }}>EPOS</span>
        </div>

        <div style={{
          color: 'rgba(201,168,76,0.6)',
          fontSize: 12, marginTop: 7,
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
        border: '1px solid rgba(201,168,76,0.2)',
        borderRadius: 20,
        padding: '28px 28px 24px',
        width: '100%',
        maxWidth: 320,
      }}>

        {/* Gold PIN dots */}
        <div style={{
          height: 28, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 10, marginBottom: 20,
        }}>
          {pin.length === 0 ? (
            <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 14, letterSpacing: '0.05em' }}>
              Enter your PIN
            </span>
          ) : (
            Array.from({ length: pin.length }).map((_, i) => (
              <div key={i} style={{
                width: 13, height: 13, borderRadius: '50%', background: '#C9A84C',
                boxShadow: '0 0 8px rgba(201,168,76,0.5)',
              }} />
            ))
          )}
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.14)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#fca5a5',
            borderRadius: 8, padding: '9px 14px',
            fontSize: 13, textAlign: 'center', marginBottom: 16, fontWeight: 500,
          }}>
            {error}
          </div>
        )}

        {/* Numpad */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
          {PAD_KEYS.map((k, i) => {
            if (k === '') return <div key={i} />;
            const isDel = k === '⌫';
            return (
              <button
                key={i}
                onClick={() => !busy && press(k)}
                disabled={busy}
                style={{
                  height: 58, borderRadius: 12, border: 'none',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  background: isDel ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.07)',
                  color: isDel ? '#fca5a5' : 'white',
                  fontSize: isDel ? 20 : 22, fontWeight: 700,
                  transition: 'background 0.1s, transform 0.07s',
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
                onMouseDown={e => { if (!busy) e.currentTarget.style.transform = 'scale(0.94)'; }}
                onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                {k}
              </button>
            );
          })}
        </div>

        {/* Sign in button */}
        <button
          onClick={() => submit()}
          disabled={busy || !pin}
          style={{
            width: '100%', height: 52, borderRadius: 12, border: 'none',
            background: busy        ? 'rgba(255,255,255,0.1)'
                      : pin.length  ? '#C9A84C'
                      : 'rgba(255,255,255,0.07)',
            color: pin.length && !busy ? '#1e3a6e' : 'rgba(255,255,255,0.3)',
            fontSize: 16, fontWeight: 800,
            cursor: pin.length && !busy ? 'pointer' : 'default',
            transition: 'background 0.15s',
            letterSpacing: '0.03em',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 36, color: 'rgba(201,168,76,0.3)',
        fontSize: 12, textAlign: 'center', letterSpacing: '0.05em',
        fontFamily: 'Inter, sans-serif',
      }}>
        siamepos.co.uk
      </div>
    </div>
  );
}
