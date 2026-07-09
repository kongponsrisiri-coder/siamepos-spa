import React, { useState } from 'react';
import { recheckLicense } from '../api.js';

// SEPOS-SPA-LICENSE-001 — shown full-screen when the till's offline license has
// lapsed (a suspended subscription whose 14-day grace has run out, or a detected
// clock rollback). Blocks the whole app. OS-agnostic (Mac + Windows tills).
export default function LockScreen({ state, onUnlocked }) {
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState('');

  const isClock = state?.reason === 'clock_rollback';

  async function recheck() {
    setChecking(true);
    setMsg('');
    try {
      const fresh = await recheckLicense();
      if (fresh && !fresh.locked) {
        onUnlocked && onUnlocked(fresh);
      } else {
        setMsg('Still inactive. If you have just paid, please allow a minute and try again, or contact SiamEPOS.');
      }
    } catch {
      setMsg('Could not reach SiamEPOS — check this device’s internet connection and try again.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100000,
      background: 'linear-gradient(160deg, var(--navy) 0%, #1a2a52 100%)',
      color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, textAlign: 'center',
    }}>
      <div style={{ maxWidth: 520 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🔒</div>
        <h1 style={{ fontSize: 30, fontWeight: 900, margin: '0 0 12px', fontFamily: "'Cormorant Garamond', Georgia, serif" }}>
          {isClock ? 'Clock change detected' : 'Subscription lapsed'}
        </h1>
        <p style={{ fontSize: 17, lineHeight: 1.5, color: '#dbe3f5', margin: '0 0 8px' }}>
          {isClock
            ? 'This till’s clock was set back, so SiamEPOS can’t confirm the subscription is active. Connect to the internet and re-check to unlock.'
            : 'This SiamEPOS Spa subscription is no longer active, so the till is locked. Your data is safe — nothing has been lost.'}
        </p>
        <p style={{ fontSize: 15, color: '#aebbd8', margin: '0 0 28px' }}>
          To reactivate, please contact SiamEPOS:<br />
          <strong style={{ color: 'white' }}>info@siamepos.co.uk</strong>
        </p>

        <button
          onClick={recheck}
          disabled={checking}
          style={{
            padding: '16px 28px', borderRadius: 12, border: 'none',
            background: checking ? '#6b6f7a' : 'var(--gold)', color: 'var(--navy)',
            fontSize: 17, fontWeight: 800, cursor: checking ? 'default' : 'pointer',
            minWidth: 240,
          }}
        >
          {checking ? 'Checking…' : 'I’ve paid — re-check now'}
        </button>

        {msg && <p style={{ fontSize: 14, color: '#ffd7a8', marginTop: 18 }}>{msg}</p>}

        <p style={{ fontSize: 12, color: '#7e8aad', marginTop: 32 }}>
          SiamEPOS Spa · once the subscription is active again, this unlocks automatically.
        </p>
      </div>
    </div>
  );
}
