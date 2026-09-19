// SPA-ANDROID-001 — first-run setup for the Android app.
//
// One APK serves every spa, so the very first screen asks which shop this
// tablet belongs to. The choice is saved on the device; the app never asks
// again unless someone taps "Change spa" on the login screen. Web builds have
// their address baked in and never see this screen.
import React, { useState } from 'react';
import { KNOWN_SPAS, setApiBase } from '../apiBase.js';
import { NAVY, GOLD } from '../theme.js';

export default function SpaSetupScreen({ onDone }) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy]     = useState('');
  const [error, setError]   = useState('');

  // Prove the address answers before we commit the tablet to it — a typo here
  // would otherwise look like "the app is broken" on the shop floor.
  async function choose(url, label) {
    setBusy(label); setError('');
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/i.test(clean)) {
      setError('That address should start with https://'); setBusy(''); return;
    }
    try {
      const res = await fetch(`${clean}/api/health`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`the spa answered ${res.status}`);
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error('that address is not a SiamEPOS Spa');
      setApiBase(clean);
      onDone && onDone();
    } catch (e) {
      setError(
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'No answer from that spa. Check the tablet is online, then try again.'
          : `Could not connect: ${e.message}`,
      );
      setBusy('');
    }
  }

  const card = {
    width: '100%', textAlign: 'left', padding: '16px 18px', borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.08)',
    color: 'white', fontSize: 16, fontWeight: 700, minHeight: 60, cursor: 'pointer',
  };

  return (
    <div style={{
      minHeight: '100dvh', background: NAVY, color: 'white', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ width: 'min(100%, 420px)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ textAlign: 'center', marginBottom: 6 }}>
          <div style={{ color: GOLD, fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700 }}>
            SiamEPOS Spa
          </div>
          <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 26, margin: '6px 0 4px', color: 'white' }}>
            Which spa is this?
          </h1>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>
            Choose once when you set the tablet up. You can change it later.
          </div>
        </div>

        {KNOWN_SPAS.map((s) => (
          <button key={s.key} style={card} disabled={!!busy} onClick={() => choose(s.url, s.key)}>
            {busy === s.key ? 'Connecting…' : s.name}
          </button>
        ))}

        <div style={{ marginTop: 6 }}>
          <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
            Or type your spa's address
          </label>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="https://your-spa.up.railway.app"
            autoCapitalize="none" autoCorrect="off" spellCheck="false" inputMode="url"
            style={{ marginTop: 6, background: 'rgba(255,255,255,0.10)', color: 'white', border: '1px solid rgba(255,255,255,0.3)' }}
          />
          <button
            className="primary"
            disabled={!!busy || !custom.trim()}
            onClick={() => choose(custom, 'custom')}
            style={{ marginTop: 8, width: '100%', minHeight: 48, background: GOLD, color: NAVY, border: 'none', fontWeight: 800, fontSize: 16 }}
          >{busy === 'custom' ? 'Connecting…' : 'Connect'}</button>
        </div>

        {error && (
          <div style={{ background: 'rgba(220,38,38,0.18)', border: '1px solid rgba(248,113,113,0.5)', color: '#fecaca', borderRadius: 10, padding: '10px 14px', fontSize: 14 }}>
            {error}
          </div>
        )}

        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, textAlign: 'center', marginTop: 4 }}>
          Not sure which to pick? Ask SiamEPOS — info@siamepos.co.uk
        </div>
      </div>
    </div>
  );
}
