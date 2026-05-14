import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function NewAppointmentModal({ defaultDate, onClose, onCreated }) {
  const [treatments, setTreatments] = useState([]);
  const [therapists, setTherapists] = useState([]);
  const [clients, setClients] = useState([]);
  const [clientQuery, setClientQuery] = useState('');
  const [clientId, setClientId] = useState(null);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [treatmentId, setTreatmentId] = useState(null);
  const [therapistId, setTherapistId] = useState(null);
  const [date, setDate] = useState(defaultDate || new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState([]);
  const [slot, setSlot] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/treatments'), api.get('/therapists')]).then(([t, th]) => {
      setTreatments(t.treatments);
      setTherapists(th.therapists);
    });
  }, []);

  useEffect(() => {
    if (!clientQuery) { setClients([]); return; }
    const id = setTimeout(() => {
      api.get(`/clients?q=${encodeURIComponent(clientQuery)}`).then((r) => setClients(r.clients));
    }, 250);
    return () => clearTimeout(id);
  }, [clientQuery]);

  useEffect(() => {
    if (!treatmentId || !date) { setSlots([]); return; }
    const url = `/appointments/availability?treatment_id=${treatmentId}&date=${date}` +
                (therapistId ? `&therapist_id=${therapistId}` : '');
    api.get(url).then((r) => setSlots(r.slots));
  }, [treatmentId, date, therapistId]);

  async function submit() {
    if (!treatmentId || !slot) { setError('Pick a treatment + time slot'); return; }
    setBusy(true); setError('');
    try {
      let useClientId = clientId;
      if (!useClientId && newClientName) {
        const r = await api.post('/clients', { name: newClientName, phone: newClientPhone });
        useClientId = r.client.id;
      }
      const body = {
        client_id: useClientId,
        treatment_id: Number(treatmentId),
        therapist_id: therapistId ? Number(therapistId) : null,
        starts_at: slot,
        notes: notes || null,
        source: 'walkin',
      };
      const r = await api.post('/appointments', body);
      onCreated(r.appointment);
    } catch (e) {
      setError(e.message || 'Failed to create');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>New Appointment</h3>

        <div className="col">
          <div>
            <label>Client</label>
            {clientId ? (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>{clients.find((c) => c.id === clientId)?.name || '(selected)'}</span>
                <button onClick={() => { setClientId(null); setClientQuery(''); }}>Change</button>
              </div>
            ) : (
              <>
                <input
                  placeholder="Search by name or phone"
                  value={clientQuery}
                  onChange={(e) => setClientQuery(e.target.value)}
                />
                {clients.length > 0 && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 4, maxHeight: 120, overflow: 'auto' }}>
                    {clients.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => setClientId(c.id)}
                        style={{ padding: '6px 10px', cursor: 'pointer' }}
                      >{c.name} {c.phone && `· ${c.phone}`}</div>
                    ))}
                  </div>
                )}
                <details style={{ marginTop: 8 }}>
                  <summary className="muted" style={{ cursor: 'pointer' }}>+ Create new client</summary>
                  <div className="col" style={{ marginTop: 6 }}>
                    <input placeholder="Name" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} />
                    <input placeholder="Phone" value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} />
                  </div>
                </details>
              </>
            )}
          </div>

          <div>
            <label>Treatment</label>
            <select value={treatmentId || ''} onChange={(e) => setTreatmentId(e.target.value || null)}>
              <option value="">— Choose —</option>
              {treatments.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.duration_minutes}min · £{Number(t.price).toFixed(2)}
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Therapist (optional)</label>
              <select value={therapistId || ''} onChange={(e) => setTherapistId(e.target.value || null)}>
                <option value="">No preference</option>
                {therapists.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label>Time slot</label>
            {!treatmentId ? (
              <div className="muted">Pick a treatment first.</div>
            ) : slots.length === 0 ? (
              <div className="muted">No availability for this date.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, maxHeight: 140, overflow: 'auto' }}>
                {slots.map((s) => {
                  const t = new Date(s.starts_at);
                  const label = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                  const selected = slot === s.starts_at;
                  return (
                    <button
                      key={s.starts_at}
                      className={selected ? 'primary' : ''}
                      onClick={() => setSlot(s.starts_at)}
                      style={{ padding: '8px 0' }}
                    >{label}</button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label>Notes (optional)</label>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy}>
              {busy ? 'Booking…' : 'Book appointment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
