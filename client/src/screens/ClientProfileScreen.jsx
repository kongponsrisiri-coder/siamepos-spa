import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, getStaff } from '../api.js';
import MedicalQuestionnaireForm from '../components/MedicalQuestionnaireForm.jsx';

function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB') : '—'; }

export default function ClientProfileScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, setClient]           = useState(null);
  const [medical, setMedical]         = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [tab, setTab]                 = useState('profile');
  const [editing, setEditing]         = useState(false);
  const [draft, setDraft]             = useState(null);
  const [error, setError]             = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/clients/${id}`);
      setClient(r.client);
      setMedical(r.medical);
      setAppointments(r.appointments);
    } catch (e) { setError(e.message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function startEdit() {
    setDraft({ ...client });
    setEditing(true);
  }

  async function saveEdit() {
    try {
      await api.put(`/clients/${id}`, draft);
      setEditing(false);
      load();
    } catch (e) { alert(e.message); }
  }

  async function gdprErase() {
    if (!confirm(`Permanently delete ${client.name} and ALL their records?\n\nThis is irreversible (UK GDPR right to erasure).`)) return;
    try {
      await api.del(`/clients/${id}`);
      navigate('/clients', { replace: true });
    } catch (e) { alert(e.message); }
  }

  if (error) return <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>;
  if (!client) return <div className="muted">Loading…</div>;

  const staff = getStaff();
  const isAdmin = staff?.role === 'admin';

  return (
    <div className="col">
      <button onClick={() => navigate('/clients')} style={{ alignSelf: 'flex-start' }}>← Back to clients</button>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>{client.name}</h2>
            <div className="muted">
              {client.phone || '—'} · {client.email || '—'}
            </div>
          </div>
          <div className="row">
            {!editing && <button onClick={startEdit}>Edit</button>}
            {isAdmin && !editing && <button className="danger" onClick={gdprErase}>GDPR delete</button>}
          </div>
        </div>

        <div className="row" style={{ marginTop: 14, borderBottom: '1px solid var(--border)' }}>
          {[
            { k: 'profile',   t: 'Profile' },
            { k: 'medical',   t: medical ? 'Medical ✓' : 'Medical' },
            { k: 'history',   t: `History (${appointments.length})` },
          ].map((tabDef) => (
            <button
              key={tabDef.k}
              onClick={() => setTab(tabDef.k)}
              style={{
                border: 'none',
                background: 'transparent',
                borderBottom: tab === tabDef.k ? '2px solid var(--primary)' : '2px solid transparent',
                borderRadius: 0,
                padding: '8px 12px',
                color: tab === tabDef.k ? 'var(--primary)' : 'var(--text)',
                fontWeight: tab === tabDef.k ? 600 : 400,
              }}
            >{tabDef.t}</button>
          ))}
        </div>
      </div>

      {tab === 'profile' && (editing ? (
        <ProfileEditor draft={draft} setDraft={setDraft} onCancel={() => setEditing(false)} onSave={saveEdit} />
      ) : (
        <ProfileView client={client} />
      ))}

      {tab === 'medical' && (
        !client.gdpr_consent ? (
          <div className="card" style={{ background: '#fee2e2', borderColor: '#fca5a5' }}>
            <strong>GDPR consent missing.</strong>
            <div>Edit the profile and tick "GDPR consent obtained" before recording medical data.</div>
          </div>
        ) : (
          <MedicalQuestionnaireForm clientId={client.id} initial={medical} onSaved={(m) => setMedical(m)} />
        )
      )}

      {tab === 'history' && (
        <div className="col">
          {appointments.length === 0 && <div className="muted">No past appointments.</div>}
          {appointments.map((a) => (
            <div key={a.id} className="card" style={{ padding: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div>{new Date(a.starts_at).toLocaleString('en-GB')}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{a.treatment_name || '—'}</div>
                </div>
                <span className={`status-pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileView({ client }) {
  const row = (k, v) => (
    <div key={k} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <div className="muted" style={{ fontSize: 12 }}>{k}</div>
      <div>{v || '—'}</div>
    </div>
  );
  return (
    <div className="card">
      {row('Phone', client.phone)}
      {row('Email', client.email)}
      {row('Date of birth', fmtDate(client.date_of_birth))}
      {row('Emergency contact', [client.emergency_contact_name, client.emergency_contact_phone].filter(Boolean).join(' · '))}
      {row('GP', [client.gp_name, client.gp_surgery].filter(Boolean).join(' · '))}
      {row('GDPR consent', client.gdpr_consent
        ? `Yes (${fmtDate(client.gdpr_consent_at)})`
        : 'No')}
      {row('Marketing opt-in', client.marketing_consent ? 'Yes' : 'No')}
      {row('Notes', client.notes)}
    </div>
  );
}

function ProfileEditor({ draft, setDraft, onCancel, onSave }) {
  const set = (k, v) => setDraft((s) => ({ ...s, [k]: v }));
  return (
    <div className="card col">
      <div><label>Full name</label><input value={draft.name || ''} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="row">
        <div style={{ flex: 1 }}><label>Phone</label><input value={draft.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
        <div style={{ flex: 1 }}><label>Email</label><input type="email" value={draft.email || ''} onChange={(e) => set('email', e.target.value)} /></div>
      </div>
      <div><label>Date of birth</label><input type="date" value={draft.date_of_birth ? draft.date_of_birth.slice(0,10) : ''} onChange={(e) => set('date_of_birth', e.target.value || null)} /></div>
      <div className="row">
        <div style={{ flex: 1 }}><label>Emergency contact name</label><input value={draft.emergency_contact_name || ''} onChange={(e) => set('emergency_contact_name', e.target.value)} /></div>
        <div style={{ flex: 1 }}><label>Emergency phone</label><input value={draft.emergency_contact_phone || ''} onChange={(e) => set('emergency_contact_phone', e.target.value)} /></div>
      </div>
      <div className="row">
        <div style={{ flex: 1 }}><label>GP name</label><input value={draft.gp_name || ''} onChange={(e) => set('gp_name', e.target.value)} /></div>
        <div style={{ flex: 1 }}><label>GP surgery</label><input value={draft.gp_surgery || ''} onChange={(e) => set('gp_surgery', e.target.value)} /></div>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={!!draft.gdpr_consent} onChange={(e) => set('gdpr_consent', e.target.checked)} />
        <span>GDPR consent obtained (required for medical data)</span>
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={!!draft.marketing_consent} onChange={(e) => set('marketing_consent', e.target.checked)} />
        <span>Marketing email opt-in</span>
      </label>
      <div><label>Notes</label><textarea rows={3} value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={onSave}>Save</button>
      </div>
    </div>
  );
}
