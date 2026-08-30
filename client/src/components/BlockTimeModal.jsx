// SPA-BLOCK-EASY-001 — one-tap time block.
// The client's ask: "just create a block button that easy to put it on."
// Before this, blocking time meant walking the full New Appointment form and
// picking a treatment just to get an end time. This modal needs only a
// therapist, a start, and a duration chip — no treatment, no client.
import { useState } from 'react';
import { api } from '../api.js';

const pad = (n) => String(n).padStart(2, '0');

// SPA-BLOCK-GRANULAR-001 (client ask) — short chips only. Half day and Rest
// of day removed: whole/part days off belong in Admin → Rota (day-off
// override), which the diary respects properly.
const DURATIONS = [
  { mins: 15,  label: '15 min' },
  { mins: 30,  label: '30 min' },
  { mins: 45,  label: '45 min' },
  { mins: 60,  label: '1 hr' },
  { mins: 90,  label: '1½ hr' },
  { mins: 120, label: '2 hr' },
];

export default function BlockTimeModal({ therapists, defaultTherapistId, defaultDate, defaultTime, onClose, onSaved }) {
  const [therapistId, setTherapistId] = useState(defaultTherapistId ? String(defaultTherapistId) : '');
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(() => {
    if (defaultTime) return defaultTime;
    // Default to the next quarter-hour so "block from now" is one tap.
    const d = new Date();
    const m = Math.ceil(d.getMinutes() / 15) * 15;
    d.setMinutes(m, 0, 0);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [duration, setDuration] = useState(60);
  const [reason, setReason]     = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  function effectiveMinutes() {
    return duration;
  }

  async function save() {
    if (!therapistId) { setError('Pick a therapist'); return; }
    if (!date || !time) { setError('Pick a date and start time'); return; }
    setBusy(true); setError('');
    try {
      // Same local→UTC composition as the booking form, so BST is handled
      // identically. allow_past=1: blocking from a slot that just passed is fine.
      const starts_at = new Date(`${date}T${time}:00`).toISOString();
      await api.post('/appointments?allow_past=1', {
        source:           'block',
        therapist_id:     Number(therapistId),
        starts_at,
        duration_minutes: effectiveMinutes(),
        notes:            reason.trim() || null,
      });
      onSaved();
    } catch (e) {
      if (e.status === 409) {
        setError(e.data?.message || 'That time overlaps an existing booking — pick a shorter duration or another start.');
      } else {
        setError(e.message || 'Could not create the block');
      }
      setBusy(false);
    }
  }

  const endPreview = (() => {
    const [h, m] = time.split(':').map(Number);
    const end = h * 60 + (m || 0) + effectiveMinutes();
    return `${pad(Math.floor(end / 60) % 24)}:${pad(end % 60)}`;
  })();

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>🚫 Block time</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
        </div>

        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Holds the slot with no booking — no notifications, nothing to check out. Online bookings can’t land on it.
        </div>

        <div className="col" style={{ gap: 10 }}>
          <div>
            <label>Therapist</label>
            <select value={therapistId} onChange={e => setTherapistId(e.target.value)}>
              <option value="">— pick —</option>
              {therapists.map(t => (
                <option key={t.id} value={t.id}>{t.name}{t.isOff ? ' (off today)' : ''}</option>
              ))}
            </select>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label>Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label>From</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} step={900} />
            </div>
          </div>

          <div>
            <label>How long</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {DURATIONS.map(d => {
                const active = duration === d.mins;
                return (
                  <button
                    key={String(d.mins)}
                    type="button"
                    onClick={() => setDuration(d.mins)}
                    style={{
                      flex: '1 1 90px', padding: '10px 8px', minHeight: 44,
                      background: active ? '#4b5563' : '#e5e7eb',
                      color: active ? 'white' : '#1f2937',
                      border: '2px solid #4b5563', borderRadius: 6,
                      fontWeight: 700, fontSize: 13,
                    }}
                  >{d.label}</button>
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Blocked until ~{endPreview}</div>
          </div>

          <div>
            <label>Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. lunch, dentist, training"
              maxLength={80}
            />
          </div>

          {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}

          <button className="primary" onClick={save} disabled={busy} style={{ minHeight: 48, fontWeight: 700, fontSize: 15 }}>
            {busy ? 'Blocking…' : '🚫 Block this time'}
          </button>
        </div>
      </div>
    </div>
  );
}
