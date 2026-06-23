import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api.js';

// SEPOS-SPA-BUGHUNT — name-then-PIN login (matches the restaurant EPOS):
// tap your name → enter your PIN. Login then bcrypt-checks a SINGLE staff row
// instead of every row, which kills the login DoS the stress test found.

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

export default function LoginScreen() {
  const [staff, setStaff] = useState([]);
  const [sel, setSel]     = useState(null);   // selected staff member
  const [pin, setPin]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/auth/staff').then((r) => setStaff(r.staff || [])).catch(() => setStaff([]));
  }, []);

  function pickStaff(s) { setSel(s); setPin(''); setError(''); }

  function press(k) {
    setError('');
    if (!sel) { setError('Tap your name first'); return; }
    if (k === '⌫') { setPin((p) => p.slice(0, -1)); return; }
    if (k === '' ) return;
    if (pin.length >= 8) return;
    setPin((p) => p + k);
  }

  async function submit() {
    if (!sel || !pin) return;
    setBusy(true); setError('');
    try {
      const { token, staff: who } = await api.post('/auth/login', { staff_id: sel.id, pin });
      setAuth({ token, staff: who });
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message === 'invalid pin' ? 'Wrong PIN — try again' : (e.message || 'Login failed'));
      setPin('');
    } finally { setBusy(false); }
  }

  function onKeyDown(e) {
    if (e.key >= '0' && e.key <= '9') press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') submit();
  }

  return (
    <div onKeyDown={onKeyDown} tabIndex={0} style={{
      minHeight: '100dvh', background: '#0D1B3E', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '24px 16px', outline: 'none',
    }}>
      {/* Lotus + wordmark */}
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <svg viewBox="0 0 100 100" style={{ width: 64, height: 64, display: 'block', margin: '0 auto 12px' }} aria-hidden="true">
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
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 38, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>
          <span style={{ color: 'white' }}>Siam</span><span style={{ color: '#C9A84C' }}>EPOS</span>
        </div>
        <div style={{ color: 'rgba(201,168,76,0.75)', fontSize: 12, marginTop: 8, letterSpacing: '0.22em', textTransform: 'uppercase', fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 600 }}>
          Spa · Staff Login
        </div>
      </div>

      {/* Two-panel card: name picker + keypad (stacks on narrow screens) */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center',
        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(201,168,76,0.25)',
        borderRadius: 20, padding: 20, width: '100%', maxWidth: 560,
      }}>
        {/* ── Name picker ── */}
        <div style={{ flex: '1 1 200px', minWidth: 200 }}>
          <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            Tap your name
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {staff.length === 0 && <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, fontFamily: 'system-ui, sans-serif' }}>No staff found.</div>}
            {staff.map((s) => {
              const active = sel?.id === s.id;
              return (
                <button key={s.id} onClick={() => pickStaff(s)} style={{
                  minHeight: 50, borderRadius: 11, cursor: 'pointer', padding: '8px 12px', textAlign: 'left',
                  border: active ? '1px solid #C9A84C' : '1px solid rgba(201,168,76,0.22)',
                  background: active ? 'rgba(201,168,76,0.18)' : 'rgba(255,255,255,0.04)',
                  color: 'white', fontFamily: 'system-ui, -apple-system, sans-serif',
                  WebkitTapHighlightColor: 'transparent',
                }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
                  {s.role && <div style={{ fontSize: 11, fontWeight: 500, color: active ? '#C9A84C' : 'rgba(201,168,76,0.55)', textTransform: 'capitalize' }}>{s.role}</div>}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Keypad ── */}
        <div style={{ flex: '1 1 220px', minWidth: 220, maxWidth: 280 }}>
          <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 14 }}>
            {!sel ? (
              <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 14, fontFamily: 'system-ui, sans-serif' }}>Select your name</span>
            ) : pin.length === 0 ? (
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14, fontFamily: 'system-ui, sans-serif' }}>{sel.name} — enter PIN</span>
            ) : (
              Array.from({ length: pin.length }).map((_, i) => (
                <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: '#C9A84C', boxShadow: '0 0 8px rgba(201,168,76,0.55)' }} />
              ))
            )}
          </div>
          <div style={{ height: 34, marginBottom: 10 }}>
            {error && (
              <div style={{ background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5', borderRadius: 8, padding: '7px 12px', fontSize: 13, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>{error}</div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12, opacity: sel ? 1 : 0.5 }}>
            {PAD_KEYS.map((k, i) => {
              if (k === '') return <div key={i} />;
              const isDel = k === '⌫';
              return (
                <button key={i} onClick={() => !busy && press(k)} disabled={busy || !sel} style={{
                  height: 58, borderRadius: 12,
                  border: isDel ? '1px solid rgba(239,68,68,0.25)' : '1px solid rgba(255,255,255,0.10)',
                  cursor: sel && !busy ? 'pointer' : 'default',
                  background: isDel ? 'rgba(239,68,68,0.10)' : 'rgba(255,255,255,0.08)',
                  color: isDel ? '#fca5a5' : 'white', fontSize: isDel ? 20 : 24, fontWeight: 700,
                  fontFamily: 'system-ui, -apple-system, sans-serif', WebkitTapHighlightColor: 'transparent',
                }}>{k}</button>
              );
            })}
          </div>
          <button onClick={submit} disabled={busy || !sel || !pin} style={{
            width: '100%', height: 54, borderRadius: 12, border: 'none',
            background: busy ? 'rgba(255,255,255,0.08)' : (sel && pin) ? '#C9A84C' : 'rgba(255,255,255,0.06)',
            color: (sel && pin && !busy) ? '#0D1B3E' : 'rgba(255,255,255,0.28)',
            fontSize: 16, fontWeight: 800, cursor: (sel && pin && !busy) ? 'pointer' : 'default',
            letterSpacing: '0.04em', fontFamily: 'system-ui, -apple-system, sans-serif', WebkitTapHighlightColor: 'transparent',
          }}>{busy ? 'Signing in…' : 'Sign In'}</button>
        </div>
      </div>

      <a href="/owner-login" style={{ marginTop: 22, color: 'rgba(201,168,76,0.8)', fontSize: 13, textDecoration: 'none', fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 600 }}>
        Owner login →
      </a>
      <div style={{ marginTop: 18, color: 'rgba(201,168,76,0.35)', fontSize: 12, letterSpacing: '0.05em', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        siamepos.co.uk
      </div>
    </div>
  );
}
