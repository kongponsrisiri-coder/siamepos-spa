import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }

export default function TreatmentMenuSection() {
  const [treatments, setTreatments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [editing, setEditing]       = useState(null);
  const [newCatName, setNewCatName] = useState('');

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([api.get('/treatments'), api.get('/treatments/categories')]);
    setTreatments(t.treatments);
    setCategories(c.categories);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addCategory() {
    if (!newCatName.trim()) return;
    await api.post('/treatments/categories', { name: newCatName.trim() });
    setNewCatName('');
    load();
  }

  async function softDelete(id) {
    if (!confirm('Hide this treatment from the menu?')) return;
    await api.del(`/treatments/${id}`);
    load();
  }

  function openNew() {
    setEditing({ name: '', duration_minutes: 60, price: 0, description: '', category_id: categories[0]?.id || null });
  }

  async function save() {
    if (!editing.name) return alert('Name required');
    const body = {
      name: editing.name,
      duration_minutes: Number(editing.duration_minutes),
      price: Number(editing.price),
      description: editing.description || null,
      category_id: editing.category_id || null,
    };
    if (editing.id) await api.put(`/treatments/${editing.id}`, body);
    else            await api.post('/treatments', body);
    setEditing(null);
    load();
  }

  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Categories</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {categories.map((c) => (
            <span key={c.id} className="status-pill" style={{ background: '#f3f4f6', color: 'var(--text)' }}>{c.name}</span>
          ))}
        </div>
        <div className="row">
          <input placeholder="New category name" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
          <button onClick={addCategory}>Add</button>
        </div>
      </div>

      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Treatments</h3>
          <button className="primary" onClick={openNew}>+ New Treatment</button>
        </div>
        {treatments.length === 0 ? <div className="muted">No treatments yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Name</th>
                <th style={{ padding: '6px 4px' }}>Category</th>
                <th style={{ padding: '6px 4px' }}>Duration</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {treatments.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 4px' }}>{t.name}</td>
                  <td style={{ padding: '6px 4px' }}>{t.category_name || '—'}</td>
                  <td style={{ padding: '6px 4px' }}>{t.duration_minutes} min</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{fmtMoney(t.price)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                    <button onClick={() => setEditing({ ...t })}>Edit</button>{' '}
                    <button onClick={() => softDelete(t.id)}>Hide</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? 'Edit treatment' : 'New treatment'}</h3>
            <div className="col">
              <div><label>Name</label><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
              <div><label>Category</label>
                <select value={editing.category_id || ''} onChange={(e) => setEditing({ ...editing, category_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— None —</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="row">
                <div style={{ flex: 1 }}><label>Duration (min)</label><input type="number" value={editing.duration_minutes} onChange={(e) => setEditing({ ...editing, duration_minutes: e.target.value })} /></div>
                <div style={{ flex: 1 }}><label>Price (£)</label><input type="number" step="0.5" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} /></div>
              </div>
              <div><label>Description</label><textarea rows={2} value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button className="primary" onClick={save}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
