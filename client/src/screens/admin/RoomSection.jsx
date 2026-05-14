import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

export default function RoomSection() {
  const [rooms, setRooms]   = useState([]);
  const [name, setName]     = useState('');
  const [editing, setEdit]  = useState(null);

  const load = useCallback(async () => {
    const r = await api.get('/rooms');
    setRooms(r.rooms);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!name.trim()) return;
    await api.post('/rooms', { name: name.trim() });
    setName('');
    load();
  }

  async function save() {
    await api.put(`/rooms/${editing.id}`, { name: editing.name, active: editing.active !== false });
    setEdit(null);
    load();
  }

  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Rooms / Beds</h3>
        {rooms.length === 0 ? <div className="muted">No rooms yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Name</th>
                <th style={{ padding: '6px 4px' }}>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 4px' }}>{r.name}</td>
                  <td style={{ padding: '6px 4px' }}>{r.active ? 'Yes' : 'No'}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                    <button onClick={() => setEdit({ ...r })}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          <input placeholder="New room name (e.g. Room 1)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" onClick={add}>Add</button>
        </div>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Edit room</h3>
            <div className="col">
              <div><label>Name</label><input value={editing.name} onChange={(e) => setEdit({ ...editing, name: e.target.value })} /></div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={editing.active !== false}
                  onChange={(e) => setEdit({ ...editing, active: e.target.checked })} />
                <span>Active</span>
              </label>
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
