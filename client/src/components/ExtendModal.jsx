// SPA-EXTEND-001 — ต่อเวลานวด / Extend a running booking.
// Quick +15/+30/+45/+60, price preview (pro-rata from the treatment, editable),
// server-side conflict check. On a clash the server returns the therapists
// who are free for the extra minutes and the operator can hand the
// extension over to one of them.
import React, { useState } from 'react';
import { api } from '../api.js';

const OPTIONS = [15, 30, 45, 60];

export default function ExtendModal({ appt, onClose, onDone }) {
  const [minutes, setMinutes] = useState(30);
  const [price, setPrice]     = useState('');      // '' = use pro-rata default
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');
  const [conflict, setConflict] = useState(null);  // 409 payload

  const base = Number(appt.price_at_booking ?? 0) - Number(appt.extension_price ?? 0);
  const dur  = Number(appt.duration_minutes) || 60;
  const suggested = +((base / dur) * minutes).toFixed(2);
  const effective = price === '' ? suggested : Number(price);
  const endsAt = new Date(appt.ends_at);
  const newEnd = new Date(endsAt.getTime() + minutes * 60_000);
  const fmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  async function submit(therapistId) {
    setBusy(true); setError('');
    try {
      const body = { minutes };
      if (price !== '') body.price = Number(price);
      if (therapistId) body.therapist_id = therapistId;
      const r = await api.post(`/appointments/${appt.id}/extend`, body);
      onDone && onDone(r);
      onClose();
    } catch (e) {
      const data = e.data || e.body || null;
      if (e.status === 409 && data && data.code === 'therapist_unavailable') {
        setConflict(data);
      } else {
        setError(e.message || 'Could not extend');
      }
    } finally { setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,27,62,0.55)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div style={{ background: 'white', borderRadius: 14, width: 'min(96vw, 440px)', padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>⏱ Extend booking</h3>
          <button onClick={onClose} disabled={busy} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          {appt.client_name || 'Walk-in'} · {appt.treatment_name || 'treatment'} · ends {fmt(endsAt)}{appt.therapist_name ? ' · ' + appt.therapist_name : ''}
        </div>

        {!conflict && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
              {OPTIONS.map((m) => (
                <button key={m} onClick={() => setMinutes(m)} style={{
                  minHeight: 48, borderRadius: 10, fontWeight: 800, fontSize: 16,
                  background: minutes === m ? 'var(--navy, #0D1B3E)' : 'white',
                  color: minutes === m ? 'white' : 'var(--navy, #0D1B3E)',
                  border: `2px solid ${minutes === m ? 'var(--navy, #0D1B3E)' : 'var(--border, #e5e7eb)'}`,
                }}>+{m}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12 }}>Extra charge (£)</label>
                <input type="number" step="0.5" min="0" value={price} placeholder={suggested.toFixed(2)}
                  onChange={(e) => setPrice(e.target.value)} />
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Suggested {`£${suggested.toFixed(2)}`} (same rate as the treatment). Leave blank to use it.</div>
              </div>
              <div style={{ textAlign: 'right', paddingBottom: 18, whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>New end</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{fmt(newEnd)}</div>
              </div>
            </div>
            {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 10 }}>⚠️ {error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onClose} disabled={busy} style={{ flex: 1, minHeight: 44 }}>Cancel</button>
              <button className="primary" onClick={() => submit(null)} disabled={busy} style={{ flex: 2, minHeight: 44, fontWeight: 800 }}>
                {busy ? 'Checking…' : `Extend +${minutes} min · £${effective.toFixed(2)}`}
              </button>
            </div>
          </>
        )}

        {conflict && (
          <>
            <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', borderRadius: 10, padding: '10px 12px', fontSize: 14, marginBottom: 12 }}>
              ⚠️ {conflict.message}
            </div>
            {conflict.alternative_therapists && conflict.alternative_therapists.length > 0 ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Assign a different therapist for the extra {minutes} min?</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  {conflict.alternative_therapists.map((t) => (
                    <button key={t.id} disabled={busy} onClick={() => submit(t.id)} style={{ minHeight: 44, borderRadius: 10, padding: '0 16px', fontWeight: 700, background: 'var(--navy, #0D1B3E)', color: 'white', border: 'none' }}>
                      {t.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>No other therapist is free for that time. Try fewer minutes or move the next booking.</div>
            )}
            {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 10 }}>⚠️ {error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConflict(null)} disabled={busy} style={{ flex: 1, minHeight: 44 }}>← Back</button>
              <button onClick={onClose} disabled={busy} style={{ flex: 1, minHeight: 44 }}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
