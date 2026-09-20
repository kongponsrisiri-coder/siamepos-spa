// SPA-IDLE-LOGOUT-001 — sign the till out when nobody is using it.
//
// A spa till sits on the reception desk with a client's medical notes, phone
// number and card history one tap away, and staff walk away from it between
// treatments without signing out. After the idle time the till returns to the
// PIN screen, so the next person has to be themselves — which is also what
// makes the booking audit trail mean anything.
//
// It warns before it acts. Being dumped to the PIN screen with no notice while
// you are reading a client's notes is the kind of "security" people work around
// by sharing a PIN, so the last 20 seconds are a visible countdown that any
// touch cancels.
//
// Per-spa, set in Admin → Settings → "Sign out when idle". 0 turns it off.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearAuth } from '../api.js';
import { NAVY, GOLD } from '../theme.js';

const DEFAULT_MINUTES = 2;
const WARN_SECONDS    = 20;
// A fly on a touchscreen should not keep the till signed in forever, but a
// receptionist reading the diary moves the mouse — so movement counts, at most
// once a second.
const MOVE_THROTTLE_MS = 1000;

export default function IdleLogout() {
  const navigate = useNavigate();
  const [limitMs, setLimitMs]   = useState(null);   // null = not loaded yet
  const [remaining, setRemaining] = useState(null); // seconds left, or null when not warning
  const lastActivity = useRef(Date.now());
  const lastMove     = useRef(0);
  const firedRef     = useRef(false);

  // Per-spa setting. Readable by every signed-in role (GET /settings is
  // auth-only — the permission gate covers writes), so reception tills get it
  // too, not just admins.
  useEffect(() => {
    let alive = true;
    api.get('/settings')
      .then((r) => {
        if (!alive) return;
        const raw = r?.settings?.auto_logout_minutes;
        const mins = raw === undefined || raw === null || raw === ''
          ? DEFAULT_MINUTES
          : Number(raw);
        setLimitMs(Number.isFinite(mins) && mins > 0 ? mins * 60000 : 0);
      })
      .catch(() => { if (alive) setLimitMs(DEFAULT_MINUTES * 60000); });
    return () => { alive = false; };
  }, []);

  const bump = useCallback(() => {
    lastActivity.current = Date.now();
    setRemaining((r) => (r === null ? r : null));   // cancel a running warning
  }, []);

  useEffect(() => {
    if (!limitMs) return undefined;   // 0 or not loaded = disabled

    const onMove = () => {
      const now = Date.now();
      if (now - lastMove.current < MOVE_THROTTLE_MS) return;
      lastMove.current = now;
      bump();
    };
    const onWake = () => { if (document.visibilityState === 'visible') bump(); };

    const direct = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'];
    direct.forEach((e) => window.addEventListener(e, bump, { passive: true, capture: true }));
    window.addEventListener('pointermove', onMove, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onWake);

    const tick = setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= limitMs) {
        if (firedRef.current) return;
        firedRef.current = true;
        clearAuth();
        // replace: the back button must not walk into a signed-in screen.
        navigate('/login', { replace: true, state: { reason: 'idle' } });
        return;
      }
      const left = Math.ceil((limitMs - idle) / 1000);
      setRemaining(left <= WARN_SECONDS ? left : null);
    }, 1000);

    return () => {
      clearInterval(tick);
      direct.forEach((e) => window.removeEventListener(e, bump, { capture: true }));
      window.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [limitMs, bump, navigate]);

  if (remaining === null) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(13,27,62,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={bump}
    >
      <div style={{
        background: 'white', borderRadius: 16, padding: '26px 28px',
        width: 'min(92vw, 380px)', textAlign: 'center',
        boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
      }}>
        <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 10 }}>🔒</div>
        <h3 style={{ margin: '0 0 6px', fontFamily: 'Georgia, serif', color: NAVY, fontSize: 21 }}>
          Still there?
        </h3>
        <div style={{ fontSize: 14, color: '#4b5563', lineHeight: 1.5, marginBottom: 16 }}>
          Signing out in <strong style={{ color: NAVY, fontVariantNumeric: 'tabular-nums' }}>{remaining}</strong>
          {' '}second{remaining === 1 ? '' : 's'} to keep client records private.
        </div>
        <button
          onClick={bump}
          style={{
            width: '100%', minHeight: 52, borderRadius: 12, border: 'none',
            background: GOLD, color: NAVY, fontWeight: 800, fontSize: 16, cursor: 'pointer',
          }}
        >I&rsquo;m still here</button>
        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10 }}>
          Touching the screen anywhere also keeps you signed in.
        </div>
      </div>
    </div>
  );
}
