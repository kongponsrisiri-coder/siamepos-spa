import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

// SPA-TREATWELL-001 — Treatwell email-ingest review queue.
// Successful bookings land straight on the timetable (tagged Treatwell). This
// tab surfaces only the ones that need a human: low-confidence parses, unknown
// refs, or errors — so nothing is ever silently dropped.

const NAVY = 'var(--navy)';
const GOLD = 'var(--gold)';

const ACTION_LABEL = { create: 'New', reschedule: 'Reschedule', cancel: 'Cancel' };
const STATUS_COLOR = {
  needs_review: { bg: '#fef3c7', fg: '#92400e' },
  error:        { bg: '#fee2e2', fg: '#991b1b' },
  resolved:     { bg: '#dcfce7', fg: '#166534' },
};

export default function TreatwellSection() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setError('');
    try { setItems((await api.get('/treatwell-email/review-queue')).items || []); }
    catch (e) { setError(e.message || 'Failed to load'); }
  };
  useEffect(() => { load(); }, []);

  const reprocess = async (id) => {
    setBusyId(id); setMsg('');
    try {
      const r = await api.post(`/treatwell-email/review/${id}/reprocess`, {});
      setMsg(`Re-processed: ${r.status}${r.appointment_id ? ` (appointment #${r.appointment_id})` : ''}`);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  };
  const resolve = async (id) => {
    setBusyId(id); setMsg('');
    try { await api.post(`/treatwell-email/review/${id}/resolve`, {}); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  };

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ fontFamily: "Georgia, serif", color: NAVY, margin: '0 0 4px' }}>Treatwell</h2>
      <p style={{ color: '#555', fontSize: 14, marginTop: 0, lineHeight: 1.6 }}>
        Bookings forwarded from Treatwell are read automatically and placed on the timetable
        (tagged <strong>Treatwell</strong>), creating or matching the client. Only items that
        need a quick human check appear below — they are never dropped.
      </p>

      {error && (
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}
      {msg && (
        <div style={{ background: '#dcfce7', color: '#166534', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{msg}</div>
      )}

      {items === null ? (
        <div style={{ color: '#888', padding: 24 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: 20, borderRadius: 10, fontSize: 14 }}>
          ✓ Nothing needs review — all forwarded Treatwell bookings are on the timetable.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((it) => {
            const p = it.parsed || {};
            const sc = STATUS_COLOR[it.status] || { bg: '#eee', fg: '#444' };
            return (
              <div key={it.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px', background: 'white' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span style={{ fontWeight: 800, color: NAVY }}>{p.treatment || 'Unrecognised booking'}</span>
                  {p.action && <Badge bg={NAVY} fg="white">{ACTION_LABEL[p.action] || p.action}</Badge>}
                  <Badge bg={sc.bg} fg={sc.fg}>{it.status.replace('_', ' ')}</Badge>
                  {it.confidence && <Badge bg="#eef" fg="#3730a3">{it.confidence} confidence</Badge>}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#999' }}>{it.external_ref || '—'}</span>
                </div>
                <div style={{ fontSize: 13, color: '#444', lineHeight: 1.7 }}>
                  {p.name && <>👤 {p.name} &nbsp;</>}
                  {p.startLocal && <>🕑 {p.startLocal.replace('T', ' ').slice(0, 16)} &nbsp;</>}
                  {(p.email || p.phone) && <>📞 {[p.phone, p.email].filter(Boolean).join(' · ')} &nbsp;</>}
                  {p.room && <>🚪 {p.room}</>}
                </div>
                {(it.error || (p.missing && p.missing.length)) && (
                  <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 6 }}>
                    {it.error ? `⚠️ ${it.error}` : `Missing: ${p.missing.join(', ')}`}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button disabled={busyId === it.id} onClick={() => reprocess(it.id)}
                    style={{ background: GOLD, color: NAVY, border: 'none', borderRadius: 7, padding: '7px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    {busyId === it.id ? '…' : '↻ Try again'}
                  </button>
                  <button disabled={busyId === it.id} onClick={() => resolve(it.id)}
                    style={{ background: 'transparent', color: '#555', border: '1px solid #ccc', borderRadius: 7, padding: '7px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    Mark handled
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Badge({ bg, fg, children }) {
  return (
    <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, textTransform: 'capitalize' }}>
      {children}
    </span>
  );
}
