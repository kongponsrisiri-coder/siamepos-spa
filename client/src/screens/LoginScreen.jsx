import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api.js';

const PAD_KEYS = ['1','2','3','4','5','6','7','8','9','C','0','⌫'];

export default function LoginScreen() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  function press(k) {
    setError('');
    if (k === 'C') { setPin(''); return; }
    if (k === '⌫') { setPin((p) => p.slice(0, -1)); return; }
    if (pin.length >= 8) return;
    setPin((p) => p + k);
  }

  async function submit() {
    if (!pin) return;
    setBusy(true); setError('');
    try {
      const { token, staff } = await api.post('/auth/login', { pin });
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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        outline: 'none',
      }}
    >
      <div className="card" style={{ width: 320, textAlign: 'center' }}>
        <h2 style={{ color: 'var(--primary)', margin: '0 0 4px' }}>SiamEPOS Spa</h2>
        <p className="muted" style={{ margin: '0 0 20px' }}>Enter your staff PIN</p>

        <div style={{
          height: 48,
          border: '1px solid var(--border)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 28,
          letterSpacing: 8,
          marginBottom: 16,
          background: '#fafafa',
        }}>
          {pin.replace(/./g, '●') || <span className="muted" style={{ fontSize: 14, letterSpacing: 0 }}>•••</span>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {PAD_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => press(k)}
              style={{
                padding: '18px 0',
                fontSize: 20,
                background: k === 'C' || k === '⌫' ? '#f3f4f6' : 'white',
              }}
            >{k}</button>
          ))}
        </div>

        {error && <div style={{ color: 'var(--danger)', marginTop: 14, fontSize: 14 }}>{error}</div>}

        <button
          className="primary"
          onClick={submit}
          disabled={busy || !pin}
          style={{ marginTop: 16, width: '100%', padding: '12px 0', fontSize: 16 }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
