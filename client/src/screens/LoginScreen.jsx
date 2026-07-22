import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api.js';
import { NAVY, GOLD, LOGO_PX, applyBrandTheme } from '../theme.js';

// SPA-BRAND-001 — white-label login, ported from the restaurant EPOS. Split
// panel: a customizable brand panel (spa logo + name + colours + adjustable
// logo size, all from the public /api/widget/branding endpoint) beside a light
// "paper" panel with the name-then-PIN staff picker. Colours come through the
// CSS vars set by applyBrandTheme, so a spa's theme repaints the whole app.

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS  = 'system-ui, -apple-system, sans-serif';
const PAPER = '#F4F1EA', INK = '#1a1a2e', MUTED = '#7C766A';
const GOLD_TINT = '#F1E6C7', GOLD_ON_LIGHT = '#8a6d1e';
const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const isManager = (role) => role === 'admin' || role === 'manager';

// Default lotus mark (shown when the spa hasn't uploaded a logo).
function Lotus({ size = 120 }) {
  return (
    <svg viewBox="0 0 100 100" style={{ width: size, height: size, display: 'block' }} aria-hidden="true">
      <circle cx="50" cy="50" r="45" fill="none" stroke={GOLD} strokeWidth="1.8" />
      <circle cx="50" cy="50" r="39" fill="none" stroke={GOLD} strokeWidth="0.6" opacity="0.28" />
      <g transform="translate(50,50)">
        {[0, 72, 144, 216, 288].map((deg, i) => (
          <path key={deg} d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z"
            fill={GOLD} opacity={(i === 0 || i === 4) ? 1 : (i === 1 || i === 3) ? 0.82 : 0.62} transform={`rotate(${deg})`} />
        ))}
        <circle cx="0" cy="0" r="9" fill={NAVY} /><circle cx="0" cy="0" r="5" fill={GOLD} />
      </g>
    </svg>
  );
}

// Uploaded brand logo if set, else the lotus. Same contract as the EPOS.
function BrandMark({ size = 120, logo }) {
  if (logo) return <img src={logo} alt="" style={{ height: size, maxWidth: Math.min(size * 2.4, 440), objectFit: 'contain', display: 'block' }} />;
  return <Lotus size={size} />;
}

export default function LoginScreen() {
  const [staff, setStaff] = useState([]);
  const [sel, setSel]     = useState(null);   // selected staff member
  const [pin, setPin]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [brand, setBrand] = useState({ spa_name: '', brand_logo: '', brand_logo_size: 'large' });
  // SPA-SEC-LOGIN — forced PIN change off the default 1234.
  const [mustChange, setMustChange] = useState(false);
  const [np1, setNp1] = useState('');
  const [np2, setNp2] = useState('');
  const [changeErr, setChangeErr] = useState('');
  const [now, setNow]     = useState(() => new Date());
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/auth/staff').then((r) => setStaff(r.staff || [])).catch(() => setStaff([]));
    api.get('/widget/branding').then((b) => { setBrand(b || {}); applyBrandTheme(b); }).catch(() => {});
  }, []);
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  function pickStaff(s) { setSel(s); setPin(''); setError(''); }
  function back()       { setSel(null); setPin(''); setError(''); }
  function press(k) {
    setError('');
    if (!sel) return;
    if (k === '⌫') { setPin((p) => p.slice(0, -1)); return; }
    if (k === '')  return;
    if (pin.length >= 8) return;
    setPin((p) => p + k);
  }
  async function submit() {
    if (!sel || !pin || busy) return;
    setBusy(true); setError('');
    try {
      const resp = await api.post('/auth/login', { staff_id: sel.id, pin });
      setAuth({ token: resp.token, staff: resp.staff });
      if (resp.must_change_pin) { setMustChange(true); setBusy(false); return; }
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message === 'invalid pin' ? 'Wrong PIN — try again' : (e.message || 'Login failed'));
      setPin('');
    } finally { setBusy(false); }
  }

  // SPA-SEC-LOGIN — submit the mandatory new PIN, then enter the till.
  async function submitNewPin() {
    setChangeErr('');
    if (!/^\d{4,6}$/.test(np1)) { setChangeErr('PIN must be 4–6 digits'); return; }
    if (np1 !== np2) { setChangeErr('The two PINs don’t match'); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-pin', { new_pin: np1 });
      navigate('/', { replace: true });
    } catch (e) {
      setChangeErr(e.message || 'Could not set PIN');
    } finally { setBusy(false); }
  }
  function onKeyDown(e) {
    if (e.key >= '0' && e.key <= '9') press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') back();
  }

  const spaName = brand.spa_name || 'SiamEPOS Spa';
  const lp = LOGO_PX[brand.brand_logo_size] || LOGO_PX.large;
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // ── left brand panel (customizable) ──
  const brandPanel = isMobile ? (
    <div style={{ width: '100%', flexShrink: 0, background: NAVY, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <BrandMark size={lp.mobile} logo={brand.brand_logo} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: SERIF, fontSize: 24, color: '#fff', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1.05, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spaName}</div>
        <div style={{ fontFamily: SERIF, fontSize: 12, fontWeight: 700, marginTop: 3, color: GOLD }}>SPA</div>
      </div>
    </div>
  ) : (
    <div style={{ width: 560, flexShrink: 0, background: NAVY, position: 'relative', padding: '0 64px', display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', right: -70, bottom: -70, opacity: 0.05, pointerEvents: 'none' }}><Lotus size={360} /></div>
      <BrandMark size={lp.desktop} logo={brand.brand_logo} />
      <div style={{ fontFamily: SERIF, fontSize: 56, color: '#fff', fontWeight: 700, letterSpacing: '-1.5px', lineHeight: 1.05, marginTop: 28, wordBreak: 'break-word' }}>{spaName}</div>
      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Spa · Point of sale</div>
      <div style={{ width: 64, height: 3, background: GOLD, borderRadius: 2, margin: '22px 0' }} />
      <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 5, fontWeight: 600 }}>Powered by</div>
      <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>
        <span style={{ color: '#fff' }}>Siam</span><span style={{ color: GOLD }}>EPOS</span>
      </div>
    </div>
  );

  // ── right paper panel ──
  const rightPanel = (
    <div style={{ flex: 1, minWidth: isMobile ? 'auto' : 380, background: PAPER, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: isMobile ? '28px 18px' : '40px 32px', borderRadius: isMobile ? 0 : '28px 0 0 28px' }}>
      {/* clock */}
      <div style={{ position: 'absolute', top: isMobile ? 14 : 26, right: isMobile ? 18 : 30, textAlign: 'right' }}>
        <div style={{ color: GOLD_ON_LIGHT, fontWeight: 800, fontVariantNumeric: 'tabular-nums', fontSize: 22, lineHeight: 1, fontFamily: SANS }}>{time}</div>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 3, fontFamily: SANS }}>{date}</div>
      </div>

      {!sel ? (
        <div style={{ width: '100%', maxWidth: 460, textAlign: 'center' }}>
          <div style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: INK }}>Welcome back</div>
          <div style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 26, fontFamily: SANS }}>Tap your name to sign in</div>
          {staff.length === 0 ? (
            <div style={{ color: MUTED, fontSize: 14, fontFamily: SANS, lineHeight: 1.6 }}>
              No till staff set up yet.<br />Use <b>“Sign in with email instead”</b> below, then add staff in Admin → Staff.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
              {staff.map((s) => {
                const mgr = isManager(s.role);
                return (
                  <button key={s.id} onClick={() => pickStaff(s)} style={{
                    background: '#fff', border: '1px solid #E6E0D2', borderRadius: 14, padding: '16px 10px 14px',
                    cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.05)', WebkitTapHighlightColor: 'transparent',
                  }}>
                    <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: mgr ? NAVY : GOLD_TINT, color: mgr ? GOLD : GOLD_ON_LIGHT, fontWeight: 800, fontSize: 20, fontFamily: SANS }}>
                      {initials(s.name)}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: INK, fontFamily: SANS }}>{s.name}</div>
                    {s.role && <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: GOLD_ON_LIGHT, background: GOLD_TINT, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', fontFamily: SANS }}>{s.role}</div>}
                  </button>
                );
              })}
            </div>
          )}
          <a href="/owner-login" style={{ display: 'inline-block', marginTop: 26, color: GOLD_ON_LIGHT, fontSize: 14, textDecoration: 'none', fontWeight: 700, fontFamily: SANS }}>Sign in with email instead →</a>
        </div>
      ) : (
        <div style={{ width: '100%', maxWidth: 300, textAlign: 'center' }}>
          <button onClick={back} style={{ position: 'absolute', top: isMobile ? 14 : 26, left: isMobile ? 16 : 28, background: 'none', border: 'none', color: MUTED, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: SANS }}>← Back</button>
          <div style={{ width: 84, height: 84, borderRadius: '50%', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isManager(sel.role) ? NAVY : GOLD_TINT, color: isManager(sel.role) ? GOLD : GOLD_ON_LIGHT, fontWeight: 800, fontSize: 30, fontFamily: SANS }}>
            {initials(sel.name)}
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: INK, marginTop: 14 }}>{sel.name}</div>
          {sel.role && <div style={{ color: MUTED, fontSize: 13, textTransform: 'capitalize', fontFamily: SANS }}>{sel.role}</div>}
          <div style={{ color: MUTED, fontSize: 14, marginTop: 20, marginBottom: 12, fontWeight: 600, fontFamily: SANS }}>Enter your PIN</div>
          <div style={{ height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 10 }}>
            {pin.length === 0
              ? <span style={{ color: '#c9c2b2', fontSize: 13, fontFamily: SANS }}>••••</span>
              : Array.from({ length: pin.length }).map((_, i) => <div key={i} style={{ width: 15, height: 15, borderRadius: '50%', background: NAVY }} />)}
          </div>
          <div style={{ height: 30, marginBottom: 8 }}>
            {error && <div style={{ background: '#fdecea', border: '1px solid #f5c6c2', color: '#b0281a', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontFamily: SANS }}>{error}</div>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 84px)', gap: 12, justifyContent: 'center', marginBottom: 12 }}>
            {PAD_KEYS.map((k, i) => {
              if (k === '') return <div key={i} />;
              const isDel = k === '⌫';
              return (
                <button key={i} onClick={() => !busy && press(k)} disabled={busy} style={{
                  height: 64, borderRadius: 14, border: '1px solid #E6E0D2', cursor: busy ? 'default' : 'pointer',
                  background: '#fff', color: isDel ? '#b0281a' : INK, fontSize: isDel ? 20 : 26, fontWeight: 700,
                  fontFamily: SANS, WebkitTapHighlightColor: 'transparent',
                }}>{k}</button>
              );
            })}
          </div>
          <button onClick={submit} disabled={busy || !pin} style={{
            width: '100%', height: 54, borderRadius: 14, border: 'none',
            background: (pin && !busy) ? NAVY : '#e7e1d3', color: (pin && !busy) ? '#fff' : '#b3ab98',
            fontSize: 16, fontWeight: 800, cursor: (pin && !busy) ? 'pointer' : 'default', letterSpacing: '0.03em', fontFamily: SANS,
          }}>{busy ? 'Signing in…' : 'Sign In'}</button>
        </div>
      )}
    </div>
  );

  // SPA-SEC-LOGIN — mandatory "set a new PIN" gate shown after signing in with
  // the default 1234. The public login page + a 4-digit PIN means the seeded
  // default must never persist; this makes the owner replace it on first use.
  const changePinPanel = (
    <div style={{ flex: 1, minWidth: isMobile ? 'auto' : 380, background: PAPER, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: isMobile ? '28px 18px' : '40px 32px', borderRadius: isMobile ? 0 : '28px 0 0 28px' }}>
      <div style={{ width: '100%', maxWidth: 340, textAlign: 'center' }}>
        <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: INK }}>Set your PIN</div>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 8, marginBottom: 22, fontFamily: SANS, lineHeight: 1.5 }}>
          You’re on the default PIN. Choose a private 4–6 digit PIN before you continue.
        </div>
        <input type="password" inputMode="numeric" autoFocus value={np1} maxLength={6}
          onChange={(e) => setNp1(e.target.value.replace(/\D/g, ''))} placeholder="New PIN"
          style={{ width: '100%', height: 50, borderRadius: 12, border: `1px solid #E6E0D2`, textAlign: 'center', fontSize: 20, letterSpacing: 6, marginBottom: 12, fontFamily: SANS }} />
        <input type="password" inputMode="numeric" value={np2} maxLength={6}
          onChange={(e) => setNp2(e.target.value.replace(/\D/g, ''))} placeholder="Confirm PIN"
          onKeyDown={(e) => { if (e.key === 'Enter') submitNewPin(); }}
          style={{ width: '100%', height: 50, borderRadius: 12, border: `1px solid #E6E0D2`, textAlign: 'center', fontSize: 20, letterSpacing: 6, marginBottom: 14, fontFamily: SANS }} />
        {changeErr && <div style={{ color: '#b3261e', fontSize: 13, marginBottom: 12, fontFamily: SANS }}>{changeErr}</div>}
        <button onClick={submitNewPin} disabled={busy || !np1 || !np2} style={{
          width: '100%', height: 52, borderRadius: 14, border: 'none',
          background: (np1 && np2 && !busy) ? NAVY : '#e7e1d3', color: (np1 && np2 && !busy) ? '#fff' : '#b3ab98',
          fontSize: 16, fontWeight: 800, cursor: (np1 && np2 && !busy) ? 'pointer' : 'default', fontFamily: SANS,
        }}>{busy ? 'Saving…' : 'Set PIN & continue'}</button>
      </div>
    </div>
  );

  return (
    <div onKeyDown={onKeyDown} tabIndex={0} style={{ minHeight: '100dvh', display: 'flex', flexDirection: isMobile ? 'column' : 'row', background: NAVY, outline: 'none' }}>
      {brandPanel}
      {mustChange ? changePinPanel : rightPanel}
    </div>
  );
}
