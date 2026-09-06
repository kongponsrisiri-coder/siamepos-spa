// SPA-NOTIFY-LIVE-001 — live "New booking received" alert on the till.
//
// Listens to the `new_appointment` socket event and, for bookings that
// arrived from OUTSIDE the till (online website, Treatwell, Fresha), shows a
// card in the top-right corner with the customer's name and a View button,
// and plays a short two-tone chime. Bookings the receptionist typed herself
// (phone / walk-in / staff / block) stay silent — she already knows.
//
// Sound: browsers refuse to play audio until the page has had one user
// gesture, so the chime arms itself on the first tap/click of the session.
// The Web Audio API is used so no sound file needs shipping.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { socket } from '../socket.js';

const EXTERNAL_SOURCES = new Set(['online', 'treatwell', 'fresha']);
const AUTO_HIDE_MS = 25_000;

let audioCtx = null;
function armAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio on this device */ }
}
function chime() {
  try {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;
    [[880, 0], [1174.66, 0.18]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at); osc.stop(now + at + 0.5);
    });
  } catch { /* never break the app for a sound */ }
}

const SOURCE_LABEL = { online: 'Online booking', treatwell: 'Treatwell', fresha: 'Fresha' };

function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function NewBookingAlert() {
  const [alerts, setAlerts] = useState([]);
  const navigate = useNavigate();
  const timers = useRef({});

  useEffect(() => {
    const arm = () => armAudio();
    window.addEventListener('pointerdown', arm, { passive: true });
    window.addEventListener('keydown', arm);
    return () => { window.removeEventListener('pointerdown', arm); window.removeEventListener('keydown', arm); };
  }, []);

  useEffect(() => {
    function onNew(a) {
      if (!a || !EXTERNAL_SOURCES.has(a.source)) return;
      setAlerts((list) => list.some((x) => x.id === a.id) ? list : [...list, a].slice(-4));
      chime();
      timers.current[a.id] = setTimeout(() => dismiss(a.id), AUTO_HIDE_MS);
    }
    socket.on('new_appointment', onNew);
    return () => { socket.off('new_appointment', onNew); };
  }, []);

  function dismiss(id) {
    clearTimeout(timers.current[id]); delete timers.current[id];
    setAlerts((list) => list.filter((x) => x.id !== id));
  }
  function view(a) {
    dismiss(a.id);
    navigate(`/?date=${localDate(a.starts_at)}&appt=${a.id}`);
  }

  if (alerts.length === 0) return null;
  return (
    <div style={{ position: 'fixed', top: 60, right: 12, zIndex: 99998, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(92vw, 340px)' }}>
      {alerts.map((a) => {
        const when = a.starts_at ? new Date(a.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        return (
          <div key={a.id} role="status" style={{
            background: '#0D1B3E', color: 'white', borderRadius: 12, padding: '12px 14px',
            boxShadow: '0 8px 28px rgba(13,27,62,0.35)', border: '1px solid rgba(201,168,76,0.5)',
            fontFamily: '-apple-system, system-ui, sans-serif', animation: 'spaAlertIn .25s ease-out',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--gold, #C9A84C)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  🔔 New booking received · {SOURCE_LABEL[a.source] || a.source}
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.client_name || 'New customer'}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 }}>
                  {[a.treatment_name, when, a.therapist_name ? 'with ' + a.therapist_name : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button onClick={() => dismiss(a.id)} aria-label="Dismiss" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={() => view(a)} style={{ flex: 1, background: 'var(--gold, #C9A84C)', color: '#0D1B3E', border: 'none', borderRadius: 8, padding: '8px 12px', fontWeight: 800, fontSize: 13, cursor: 'pointer', minHeight: 36 }}>View</button>
              <button onClick={() => dismiss(a.id)} style={{ background: 'rgba(255,255,255,0.1)', color: 'white', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', minHeight: 36 }}>Later</button>
            </div>
          </div>
        );
      })}
      <style>{'@keyframes spaAlertIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}'}</style>
    </div>
  );
}
