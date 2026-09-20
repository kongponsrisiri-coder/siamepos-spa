// SPA-LINE-PAIR-001 — Connect LINE.
//
// A LINE user id is not something an owner can look up, so nobody is asked to.
// The spa shows a short code, the owner messages it to our LINE account, and
// this polls until it is claimed — then booking alerts go to that chat.
//
// SPA-LINE-WHERE-001 — this card is shown in two places on purpose: under
// Settings (where configuration lives) and under Mobile App (next to the
// booking-notification switches, which is where owners actually go looking for
// it). Pass `value` if the parent already holds the settings; leave it off and
// the card loads its own.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';

// The one shared SiamEPOS Spa LINE Official Account every spa messages.
export const LINE_OA_NAME = 'SiamEPOS Spa';
export const LINE_OA_ID   = '@581wkiqk';
export const LINE_OA_ADD  = 'https://line.me/R/ti/p/%40581wkiqk';

export default function LineConnectCard({ value, onChanged, selfLoad = false }) {
  const [code, setCode]   = useState(null);
  const [state, setState] = useState('idle');  // idle | waiting | paired | error
  const [error, setError] = useState('');
  const timer = useRef(null);
  const [manual, setManual]   = useState(false);
  const [idDraft, setIdDraft] = useState('');
  const [own, setOwn]         = useState(undefined);  // used only when selfLoad

  useEffect(() => () => clearInterval(timer.current), []);

  // Stand-alone mount (Mobile App) — fetch the current recipient ourselves.
  useEffect(() => {
    if (!selfLoad) return;
    api.get('/settings').then((r) => setOwn(r.settings?.line_notify_user_id || '')).catch(() => setOwn(''));
  }, [selfLoad]);

  function changed() {
    if (selfLoad) api.get('/settings').then((r) => setOwn(r.settings?.line_notify_user_id || '')).catch(() => {});
    onChanged && onChanged();
  }

  async function start() {
    setError(''); setState('waiting'); setCode(null);
    try {
      const r = await api.post('/settings/line-pair/start', {});
      setCode(r.code);
      clearInterval(timer.current);
      const until = Date.now() + (r.expires_in_minutes || 15) * 60000;
      timer.current = setInterval(async () => {
        if (Date.now() > until) {
          clearInterval(timer.current); setState('idle');
          setError('That code expired. Start again when you are ready.');
          return;
        }
        try {
          const c = await api.get(`/settings/line-pair/check/${r.code}`);
          if (c.status === 'paired') { clearInterval(timer.current); setState('paired'); changed(); }
        } catch { /* keep waiting */ }
      }, 3000);
    } catch (e) {
      setState('error'); setError(e.message || 'Could not start — try again in a moment.');
    }
  }

  // The owner normally never sees an ID, but we sometimes already have one
  // (read from the console or an earlier chat), so allow it to be pasted.
  async function saveId() {
    await api.put('/settings', { key: 'line_notify_user_id', value: idDraft.trim() });
    setManual(false); setIdDraft(''); setState('paired');
    changed();
  }

  async function disconnect() {
    if (!window.confirm('Send booking alerts back to SiamEPOS instead of this LINE account?')) return;
    await api.put('/settings', { key: 'line_notify_user_id', value: '' });
    setState('idle'); setCode(null);
    changed();
  }

  const current   = selfLoad ? own : value;
  const connected = !!(current && String(current).trim());

  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>Booking alerts on LINE</h3>
          <div className="muted" style={{ fontSize: 13 }}>
            {connected
              ? 'New bookings are sent to your LINE chat.'
              : 'Connect your LINE and every new booking arrives as a message on your phone.'}
          </div>
        </div>
        <span style={{ padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 800,
          background: connected ? '#dcfce7' : '#f1f5f9', color: connected ? '#166534' : '#64748b' }}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {state === 'paired' && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', borderRadius: 8, padding: '10px 14px', fontSize: 14, fontWeight: 700 }}>
          ✅ Connected. Your next booking will arrive on LINE.
        </div>
      )}

      {state === 'waiting' && code && (
        <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 13, color: '#92400e', marginBottom: 8 }}>
            On your phone, open LINE, add <strong>{LINE_OA_NAME}</strong> (<strong>{LINE_OA_ID}</strong>) as
            a friend, and send it this code:
          </div>
          <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: '0.12em', color: '#0D1B3E', textAlign: 'center', padding: '8px 0' }}>
            {code}
          </div>
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <a href={LINE_OA_ADD} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 700, color: '#0D1B3E' }}>
              Open LINE and add {LINE_OA_NAME}
            </a>
          </div>
          <div style={{ fontSize: 12, color: '#92400e', textAlign: 'center' }}>
            Waiting for your message. This screen updates by itself; the code lasts 15 minutes.
          </div>
        </div>
      )}

      {manual && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label style={{ fontSize: 12 }}>LINE user ID</label>
            <input value={idDraft} onChange={(e) => setIdDraft(e.target.value)} placeholder="U…" autoCapitalize="none" spellCheck="false" />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Starts with U and is 33 characters. This is not the name you search for in LINE —
              only use it if SiamEPOS gave you the ID. Otherwise press Connect LINE.
            </div>
          </div>
          <button className="primary" disabled={!/^U[0-9a-f]{32}$/i.test(idDraft.trim())} onClick={saveId}>Save</button>
          <button onClick={() => { setManual(false); setIdDraft(''); }}>Cancel</button>
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {!connected && state !== 'waiting' && <button className="primary" onClick={start}>Connect LINE</button>}
        {connected && state !== 'waiting' && <button onClick={start}>Connect a different LINE</button>}
        {connected && <button className="danger" onClick={disconnect}>Disconnect</button>}
        {state === 'waiting' && <button onClick={() => { clearInterval(timer.current); setState('idle'); setCode(null); }}>Cancel</button>}
        {!manual && state !== 'waiting' && (
          <button onClick={() => { setManual(true); setIdDraft(''); }} style={{ fontSize: 12 }}>Enter an ID instead</button>
        )}
        {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
      </div>
    </div>
  );
}
