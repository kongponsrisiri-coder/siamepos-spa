// SPA-MENU-V2 — Treatment menu admin, reorganised + delete support.
// - Search box (filters by name + description + category name)
// - Show/Hide hidden treatments toggle
// - Grouped by category with treatment count
// - Per-treatment: Edit · Hide/Restore · 🗑 Delete (only if no bookings)
// - Per-category: Edit (rename) · 🗑 Delete (moves treatments to "Uncategorised")
// - Treatments without a category appear under "Uncategorised" at the end

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function TreatmentMenuSection() {
  const [treatments, setTreatments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [editing,    setEditing]    = useState(null);  // treatment edit modal
  const [editingCat, setEditingCat] = useState(null);  // category edit modal
  const [newCatName, setNewCatName] = useState('');
  const [search,     setSearch]     = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed,  setCollapsed]  = useState({});    // catId → bool

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([
      api.get('/treatments?include_inactive=1&with_booking_count=1'),
      api.get('/treatments/categories'),
    ]);
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
  async function deleteCategory(c) {
    if (!confirm(`Delete category "${c.name}"? Treatments in it will move to "Uncategorised".`)) return;
    await api.del(`/treatments/categories/${c.id}`);
    load();
  }
  async function saveCategoryEdit() {
    if (!editingCat?.name?.trim()) return;
    await api.put(`/treatments/categories/${editingCat.id}`, { name: editingCat.name.trim() });
    setEditingCat(null);
    load();
  }

  async function hideTreatment(t) {
    if (!confirm(`Hide "${t.name}" from the booking menu? Past bookings stay visible.`)) return;
    await api.del(`/treatments/${t.id}`);
    load();
  }
  async function restoreTreatment(t) {
    await api.put(`/treatments/${t.id}`, { active: true });
    load();
  }
  async function hardDeleteTreatment(t) {
    if (!confirm(`Permanently delete "${t.name}"? This cannot be undone.`)) return;
    try {
      await api.del(`/treatments/${t.id}?hard=1`);
      load();
    } catch (e) {
      alert(e.message || 'Could not delete');
    }
  }

  function openNew(categoryId) {
    setEditing({
      name: '', duration_minutes: 60, price: 0, description: '',
      category_id: categoryId || categories[0]?.id || null,
      online_bookable: true,
    });
  }
  async function saveTreatment() {
    if (!editing.name) return alert('Name required');
    const body = {
      name: editing.name,
      duration_minutes: Number(editing.duration_minutes),
      price: Number(editing.price),
      description: editing.description || null,
      category_id: editing.category_id || null,
      online_bookable: editing.online_bookable !== false,
    };
    if (editing.id) await api.put(`/treatments/${editing.id}`, body);
    else            await api.post('/treatments', body);
    setEditing(null);
    load();
  }

  // Filter + group
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return treatments.filter((t) => {
      if (!showHidden && !t.active) return false;
      if (!q) return true;
      const hay = [t.name, t.description, t.category_name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [treatments, search, showHidden]);

  const grouped = useMemo(() => {
    // Build a category-id → array map, plus an "Uncategorised" bucket
    const byId = new Map();
    categories.forEach((c) => byId.set(c.id, { category: c, items: [] }));
    const uncategorised = [];
    filtered.forEach((t) => {
      if (t.category_id && byId.has(t.category_id)) byId.get(t.category_id).items.push(t);
      else uncategorised.push(t);
    });
    const result = Array.from(byId.values()).filter((g) => g.items.length > 0 || categories.length <= 8);
    if (uncategorised.length > 0) result.push({ category: { id: null, name: 'Uncategorised' }, items: uncategorised });
    return result;
  }, [filtered, categories]);

  const totalActive = treatments.filter((t) => t.active).length;
  const totalHidden = treatments.filter((t) => !t.active).length;

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Treatments</h2>
          <div className="sub">Your menu — {totalActive} active{totalHidden > 0 && `, ${totalHidden} hidden`}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={() => openNew()} className="primary">+ New treatment</button>
        </div>
      </div>

      {/* ── Search + filter bar ─────────────────────────────── */}
      <div className="card col">
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder="🔍 Search name, description or category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden ({totalHidden})
          </label>
        </div>
      </div>

      {/* ── Categories admin ──────────────────────────────── */}
      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Categories</h3>
          <span className="muted" style={{ fontSize: 12 }}>Tap a pill to edit</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {categories.length === 0 && <span className="muted">No categories yet — add one below.</span>}
          {categories.map((c) => {
            const count = treatments.filter((t) => t.category_id === c.id).length;
            return (
              <span
                key={c.id}
                onClick={() => setEditingCat({ ...c })}
                style={{
                  background: '#f3f4f6',
                  color: 'var(--text)',
                  borderRadius: 14,
                  padding: '4px 12px',
                  fontSize: 13,
                  cursor: 'pointer',
                  border: '1px solid var(--border)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                title="Click to rename or delete"
              >
                {c.name}
                <span className="muted" style={{ fontSize: 11 }}>· {count}</span>
              </span>
            );
          })}
        </div>
        <div className="row">
          <input
            placeholder="New category name"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCategory()}
          />
          <button onClick={addCategory} disabled={!newCatName.trim()}>+ Add category</button>
        </div>
      </div>

      {/* ── Treatments grouped by category ────────────────── */}
      {grouped.length === 0 && (
        <div className="card muted">
          {search ? `No treatments match "${search}"` : 'No treatments yet — tap + New treatment to add one.'}
        </div>
      )}
      {grouped.map(({ category, items }) => {
        const catId = category.id || '__none__';
        const isCollapsed = collapsed[catId];
        return (
          <div key={catId} className="card col">
            <div
              className="row"
              style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
              onClick={() => setCollapsed((s) => ({ ...s, [catId]: !s[catId] }))}
            >
              <h3 style={{ margin: 0 }}>
                <span style={{ fontSize: 12, marginRight: 6, color: 'var(--muted)' }}>{isCollapsed ? '▶' : '▼'}</span>
                {category.name}
                <span className="muted" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>
                  ({items.length} treatment{items.length === 1 ? '' : 's'})
                </span>
              </h3>
              {category.id && (
                <button onClick={(e) => { e.stopPropagation(); openNew(category.id); }} style={{ fontSize: 12, padding: '4px 10px' }}>
                  + Add to "{category.name}"
                </button>
              )}
            </div>
            {!isCollapsed && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      <th style={{ padding: '6px 4px', textAlign: 'left' }}>Name</th>
                      <th style={{ padding: '6px 4px', textAlign: 'left' }}>Duration</th>
                      <th style={{ padding: '6px 4px', textAlign: 'right' }}>Price</th>
                      <th style={{ padding: '6px 4px', textAlign: 'right' }}>Bookings</th>
                      <th style={{ padding: '6px 4px', textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((t) => {
                      const canHardDelete = Number(t.booking_count || 0) === 0;
                      return (
                        <tr key={t.id} style={{ borderTop: '1px solid var(--border)', opacity: t.active ? 1 : 0.6 }}>
                          <td style={{ padding: '8px 4px' }}>
                            <div style={{ fontWeight: 600 }}>
                              {t.name}
                              {!t.active && <span style={{ marginLeft: 8, background: '#f3f4f6', color: 'var(--muted)', fontSize: 11, padding: '1px 8px', borderRadius: 10 }}>hidden</span>}
                              {t.active && t.online_bookable === false && (
                                <span title="Not shown on the public booking widget" style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', fontSize: 11, padding: '1px 8px', borderRadius: 10, fontWeight: 700 }}>
                                  🚫 in-store only
                                </span>
                              )}
                            </div>
                            {t.description && (
                              <div className="muted" style={{ fontSize: 11 }}>{t.description}</div>
                            )}
                          </td>
                          <td style={{ padding: '8px 4px' }}>{t.duration_minutes} min</td>
                          <td style={{ padding: '8px 4px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{fmtMoney(t.price)}</td>
                          <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                            {Number(t.booking_count || 0) > 0 ? (
                              <span style={{ color: 'var(--muted)', fontSize: 11 }} title={`last booked ${fmtDate(t.last_booked_at)}`}>
                                {t.booking_count}
                              </span>
                            ) : <span className="muted">—</span>}
                          </td>
                          <td style={{ padding: '8px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button onClick={() => setEditing({ ...t })} style={{ fontSize: 12, padding: '4px 10px' }}>Edit</button>
                            {' '}
                            {t.active ? (
                              <button onClick={() => hideTreatment(t)} style={{ fontSize: 12, padding: '4px 10px' }}>Hide</button>
                            ) : (
                              <button onClick={() => restoreTreatment(t)} style={{ fontSize: 12, padding: '4px 10px', color: '#16a34a', borderColor: '#16a34a' }}>Restore</button>
                            )}
                            {' '}
                            <button
                              onClick={() => hardDeleteTreatment(t)}
                              disabled={!canHardDelete}
                              title={canHardDelete ? 'Permanently delete' : `Cannot delete — has ${t.booking_count} booking(s). Hide it instead.`}
                              style={{ fontSize: 12, padding: '4px 10px', color: canHardDelete ? '#991b1b' : '#9ca3af', borderColor: canHardDelete ? '#fca5a5' : 'var(--border)' }}
                            >🗑</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* ── Edit / new treatment modal ─────────────────────── */}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? 'Edit treatment' : 'New treatment'}</h3>
            <div className="col">
              <div><label>Name</label><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
              <div>
                <label>Category</label>
                <select value={editing.category_id || ''} onChange={(e) => setEditing({ ...editing, category_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— Uncategorised —</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="row">
                <div style={{ flex: 1 }}><label>Duration (min)</label><input type="number" value={editing.duration_minutes} onChange={(e) => setEditing({ ...editing, duration_minutes: e.target.value })} /></div>
                <div style={{ flex: 1 }}><label>Price (£)</label><input type="number" step="0.5" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} /></div>
              </div>
              <div><label>Description</label><textarea rows={2} value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', padding: '8px 10px', background: editing.online_bookable === false ? '#fef3c7' : '#f0fdf4', border: `1px solid ${editing.online_bookable === false ? '#fcd34d' : '#86efac'}`, borderRadius: 6 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', accentColor: '#16a34a' }}
                  checked={editing.online_bookable !== false}
                  onChange={(e) => setEditing({ ...editing, online_bookable: e.target.checked })}
                />
                <span>
                  <strong>🌐 Show on online booking widget</strong>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    Untick to keep this treatment for in-store / phone bookings only — customers won't see it on your website.
                  </div>
                </span>
              </label>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button className="primary" onClick={saveTreatment}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit / delete category modal ───────────────────── */}
      {editingCat && (
        <div className="modal-backdrop" onClick={() => setEditingCat(null)}>
          <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Edit category</h3>
            <div className="col">
              <div>
                <label>Category name</label>
                <input value={editingCat.name} onChange={(e) => setEditingCat({ ...editingCat, name: e.target.value })} />
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {treatments.filter((t) => t.category_id === editingCat.id).length} treatment{treatments.filter((t) => t.category_id === editingCat.id).length === 1 ? '' : 's'} use this category.
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button onClick={() => deleteCategory(editingCat)} style={{ color: '#991b1b', borderColor: '#fca5a5' }}>🗑 Delete</button>
                <div className="row" style={{ gap: 6 }}>
                  <button onClick={() => setEditingCat(null)}>Cancel</button>
                  <button className="primary" onClick={saveCategoryEdit} disabled={!editingCat.name.trim()}>Save</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
