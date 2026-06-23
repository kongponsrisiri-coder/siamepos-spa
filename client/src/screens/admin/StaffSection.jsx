import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

// Till staff who sign in but are NOT bookable practitioners. They live in the
// same `therapists` table (role-based) but are kept out of the booking widget,
// rota and therapist pickers by their role. Therapists are managed separately
// under the Therapists tab.
const ROLES = [
  { value: 'reception', label: 'Reception' },
  { value: 'manager',   label: 'Manager' },
  { value: 'admin',     label: 'Admin' },
];
const roleLabel = (r) => ROLES.find((x) => x.value === r)?.label || r;

export default function StaffSection() {
  const [list, setList]    = useState([]);
  const [editing, setEdit] = useState(null);

  const load = useCallback(async () => {
    const r = await api.get('/therapists?include=staff');
    setList(r.therapists || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!editing.name) return alert('Name required');
    if (!editing.role) return alert('Role required');
    if (!editing.id && !editing.pin) return alert('PIN required for new staff');
    const body = {
      name: editing.name,
      role: editing.role,
      active: editing.active !== false,
    };
    if (editing.pin) body.pin = String(editing.pin);
    const res = editing.id
      ? await api.put(`/therapists/${editing.id}`, body)
      : await api.post('/therapists', body);
    if (res?.error) return alert(res.error);
    setEdit(null);
    load();
  }

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Staff</h2>
          <div className="sub">Reception, managers &amp; admins who sign in to the till. They are not bookable — therapists are managed under the Therapists tab.</div>
        </div>
      </div>

      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Till staff</h3>
          <button className="primary" onClick={() => setEdit({ name: '', pin: '', role: 'reception', active: true })}>+ New</button>
        </div>
        {list.length === 0 ? (
          <div className="muted">No reception or manager staff yet. Add one so they can sign in to the till.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Name</th>
                <th style={{ padding: '6px 4px' }}>Role</th>
                <th style={{ padding: '6px 4px' }}>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)', opacity: t.active === false ? 0.5 : 1 }}>
                  <td style={{ padding: '6px 4px' }}>{t.name}</td>
                  <td style={{ padding: '6px 4px' }}>{roleLabel(t.role)}</td>
                  <td style={{ padding: '6px 4px' }} className="muted">{t.active === false ? 'Inactive' : 'Active'}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                    <button onClick={() => setEdit({ ...t })}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? 'Edit staff' : 'New staff'}</h3>
            <div className="col">
              <div>
                <label>Name</label>
                <input value={editing.name} onChange={(e) => setEdit({ ...editing, name: e.target.value })} />
              </div>
              <div>
                <label>Role</label>
                <select value={editing.role || 'reception'} onChange={(e) => setEdit({ ...editing, role: e.target.value })}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label>PIN {editing.id && '(leave blank to keep current)'}</label>
                <input type="password" value={editing.pin || ''} onChange={(e) => setEdit({ ...editing, pin: e.target.value })} placeholder="4–6 digits" />
              </div>
              {editing.id && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={editing.active !== false}
                    onChange={(e) => setEdit({ ...editing, active: e.target.checked })} />
                  <span>Active (can sign in)</span>
                </label>
              )}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button onClick={() => setEdit(null)}>Cancel</button>
                <button className="primary" onClick={save}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
