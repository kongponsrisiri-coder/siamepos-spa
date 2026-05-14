import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function TherapistSection() {
  const [list, setList]     = useState([]);
  const [editing, setEdit]  = useState(null);
  const [availFor, setAvail] = useState(null); // therapist obj
  const [slots, setSlots]   = useState([]);

  const load = useCallback(async () => {
    const r = await api.get('/therapists');
    setList(r.therapists);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function openAvail(t) {
    const r = await api.get(`/therapists/${t.id}/availability`);
    setSlots(r.availability.map((s) => ({ ...s })));
    setAvail(t);
  }

  async function saveAvail() {
    await api.put(`/therapists/${availFor.id}/availability`, { slots });
    setAvail(null);
  }

  function addSlot() { setSlots((s) => [...s, { day_of_week: 1, start_time: '10:00', end_time: '18:00' }]); }
  function removeSlot(i) { setSlots((s) => s.filter((_, idx) => idx !== i)); }
  function updateSlot(i, k, v) { setSlots((s) => s.map((row, idx) => idx === i ? { ...row, [k]: v } : row)); }

  async function save() {
    if (!editing.name) return alert('Name required');
    if (!editing.id && !editing.pin) return alert('PIN required for new staff');
    const body = {
      name: editing.name,
      role: editing.role || 'therapist',
      active: editing.active !== false,
    };
    if (editing.pin) body.pin = String(editing.pin);
    if (editing.id) await api.put(`/therapists/${editing.id}`, body);
    else            await api.post('/therapists', body);
    setEdit(null);
    load();
  }

  return (
    <div className="col">
      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Therapists</h3>
          <button className="primary" onClick={() => setEdit({ name: '', pin: '', role: 'therapist' })}>+ New</button>
        </div>
        {list.length === 0 ? <div className="muted">No therapists yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Name</th>
                <th style={{ padding: '6px 4px' }}>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 4px' }}>{t.name}</td>
                  <td style={{ padding: '6px 4px' }}>{t.role}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                    <button onClick={() => openAvail(t)}>Availability</button>{' '}
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
            <h3 style={{ marginTop: 0 }}>{editing.id ? 'Edit therapist' : 'New therapist'}</h3>
            <div className="col">
              <div><label>Name</label><input value={editing.name} onChange={(e) => setEdit({ ...editing, name: e.target.value })} /></div>
              <div><label>PIN {editing.id && '(leave blank to keep current)'}</label>
                <input type="password" value={editing.pin || ''} onChange={(e) => setEdit({ ...editing, pin: e.target.value })} placeholder="4–6 digits" />
              </div>
              <div><label>Role</label>
                <select value={editing.role || 'therapist'} onChange={(e) => setEdit({ ...editing, role: e.target.value })}>
                  <option value="therapist">Therapist</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {editing.id && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={editing.active !== false}
                    onChange={(e) => setEdit({ ...editing, active: e.target.checked })} />
                  <span>Active</span>
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

      {availFor && (
        <div className="modal-backdrop" onClick={() => setAvail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{availFor.name} — availability</h3>
            <div className="col">
              {slots.map((s, i) => (
                <div key={i} className="row">
                  <select value={s.day_of_week} onChange={(e) => updateSlot(i, 'day_of_week', Number(e.target.value))}>
                    {DAYS.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
                  </select>
                  <input type="time" value={s.start_time} onChange={(e) => updateSlot(i, 'start_time', e.target.value)} />
                  <span>–</span>
                  <input type="time" value={s.end_time} onChange={(e) => updateSlot(i, 'end_time', e.target.value)} />
                  <button onClick={() => removeSlot(i)}>×</button>
                </div>
              ))}
              <button onClick={addSlot}>+ Add window</button>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button onClick={() => setAvail(null)}>Cancel</button>
                <button className="primary" onClick={saveAvail}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
