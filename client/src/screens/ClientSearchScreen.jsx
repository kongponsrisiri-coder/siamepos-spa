import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

// Same thresholds as Admin → Clients so both screens read the same.
const STATUS_STYLE = {
  VIP:     { bg: '#ede9fe', color: '#5b21b6', icon: '⭐' },
  Regular: { bg: '#dbeafe', color: '#1e40af', icon: '🔁' },
  New:     { bg: '#dcfce7', color: '#166534', icon: '🆕' },
  Lapsed:  { bg: '#fee2e2', color: '#991b1b', icon: '😴' },
};
function statusFor(visits, spend, daysSinceLast) {
  if (daysSinceLast != null && daysSinceLast > 60) return 'Lapsed';
  if (visits >= 5 || spend >= 200) return 'VIP';
  if (visits >= 2)                 return 'Regular';
  return 'New';
}
function fmtShortDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

export default function ClientSearchScreen() {
  const [q, setQ]             = useState('');
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const navigate              = useNavigate();

  async function load(query) {
    setLoading(true);
    try {
      const r = await api.get(`/clients${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setClients(r.clients);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(''); }, []);
  useEffect(() => {
    const id = setTimeout(() => load(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Clients</h2>
        <button className="primary" onClick={() => setShowNew(true)}>+ New Client</button>
      </div>

      <input
        placeholder="Search by name, phone, or email"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />

      {loading && <div className="muted">Loading…</div>}

      <div className="col" style={{ gap: 6 }}>
        {clients.map((c) => {
          const visits = Number(c.total_visits || 0);
          const spend  = Number(c.total_spend  || 0);
          const daysSinceLast = c.last_visit
            ? Math.floor((Date.now() - new Date(c.last_visit).getTime()) / 86400000)
            : null;
          const status = visits === 0 ? null : statusFor(visits, spend, daysSinceLast);
          const st = status ? STATUS_STYLE[status] : null;
          return (
            <div
              key={c.id}
              className="card"
              style={{ padding: 12, cursor: 'pointer' }}
              onClick={() => navigate(`/clients/${c.id}`)}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {c.phone || '—'} · {c.email || '—'}
                  </div>
                  {visits > 0 && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      <span style={{ color: '#1e3a6e', fontWeight: 600 }}>{visits} visit{visits === 1 ? '' : 's'}</span>
                      {spend > 0 && <span> · £{spend.toFixed(2)} lifetime</span>}
                      {c.last_visit && (
                        <span> · last {fmtShortDate(c.last_visit)}{daysSinceLast != null ? ` (${daysSinceLast === 0 ? 'today' : daysSinceLast + 'd ago'})` : ''}</span>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                  {st && (
                    <span className="status-pill" style={{ background: st.bg, color: st.color, fontWeight: 700 }}>
                      {st.icon} {status}
                    </span>
                  )}
                  {c.marketing_consent && (
                    <span className="status-pill" style={{ background: '#fef3c7', color: '#92400e' }}>
                      Marketing OK
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {!loading && clients.length === 0 && (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No clients found.</div>
        )}
      </div>

      {showNew && (
        <NewClientModal
          onClose={() => setShowNew(false)}
          onCreated={(c) => navigate(`/clients/${c.id}`)}
        />
      )}
    </div>
  );
}

function NewClientModal({ onClose, onCreated }) {
  const [b, setB] = useState({
    name: '', phone: '', email: '', date_of_birth: '',
    emergency_contact_name: '', emergency_contact_phone: '',
    gp_name: '', gp_surgery: '',
    gdpr_consent: true, marketing_consent: false, notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function set(k, v) { setB((s) => ({ ...s, [k]: v })); }

  async function save() {
    if (!b.name) { setError('Name is required'); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post('/clients', b);
      onCreated(r.client);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>New Client</h3>
        <div className="col">
          <div><label>Full name *</label><input value={b.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="row">
            <div style={{ flex: 1 }}><label>Phone</label><input value={b.phone} onChange={(e) => set('phone', e.target.value)} /></div>
            <div style={{ flex: 1 }}><label>Email</label><input type="email" value={b.email} onChange={(e) => set('email', e.target.value)} /></div>
          </div>
          <div><label>Date of birth</label><input type="date" value={b.date_of_birth} onChange={(e) => set('date_of_birth', e.target.value)} /></div>
          <div className="row">
            <div style={{ flex: 1 }}><label>Emergency contact name</label><input value={b.emergency_contact_name} onChange={(e) => set('emergency_contact_name', e.target.value)} /></div>
            <div style={{ flex: 1 }}><label>Emergency phone</label><input value={b.emergency_contact_phone} onChange={(e) => set('emergency_contact_phone', e.target.value)} /></div>
          </div>
          <div className="row">
            <div style={{ flex: 1 }}><label>GP name</label><input value={b.gp_name} onChange={(e) => set('gp_name', e.target.value)} /></div>
            <div style={{ flex: 1 }}><label>GP surgery</label><input value={b.gp_surgery} onChange={(e) => set('gp_surgery', e.target.value)} /></div>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={b.gdpr_consent} onChange={(e) => set('gdpr_consent', e.target.checked)} />
            <span>GDPR consent obtained (required to store medical record)</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={b.marketing_consent} onChange={(e) => set('marketing_consent', e.target.checked)} />
            <span>Marketing email opt-in</span>
          </label>
          {error && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
