// SPA-RBAC-001 — Admin → Roles & Permissions (admin only).
// A matrix of admin sections × roles; each cell is Hidden / View only /
// View + edit. Saved as one JSON setting (role_permissions); the server
// enforces it on the API, the till uses it for the nav and read-only mode.
import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { SECTION_GROUPS, BUILTIN_ROLES, ACTIONS, LEVELS, defaults, blankRole, refreshPermissions } from '../../permissions.js';

export default function PermissionsSection() {
  const [perms, setPerms] = useState(null);
  const [custom, setCustom] = useState([]);       // SPA-RBAC-002 — roles the owner created
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [newRole, setNewRole] = useState('');

  useEffect(() => {
    api.get('/permissions')
      .then((r) => { setCustom(r.custom_roles || []); setPerms(r.permissions || defaults(r.custom_roles || [])); })
      .catch(() => setPerms(defaults()));
  }, []);

  // Every role shown in the matrix: the three built-ins plus the owner's own.
  const ROLES = [...BUILTIN_ROLES, ...custom.map((r) => [r.key, r.label])];

  function addRole() {
    const label = newRole.trim();
    if (!label) return;
    const key = label.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 24);
    if (!key || ['admin', 'manager', 'reception', 'therapist'].includes(key) || custom.some((r) => r.key === key)) {
      alert('That role name is already taken — pick another.');
      return;
    }
    setCustom((c) => [...c, { key, label }]);
    setPerms((p) => ({ ...p, [key]: blankRole() }));
    setNewRole(''); setDirty(true);
  }
  function removeRole(key) {
    if (!confirm(`Remove the role "${key}"? Staff on this role keep their login but lose its permissions — reassign them in Admin → Staff first.`)) return;
    setCustom((c) => c.filter((r) => r.key !== key));
    setPerms((p) => { const n = { ...p }; delete n[key]; return n; });
    setDirty(true);
  }

  function set(role, section, level) {
    setPerms((p) => ({ ...p, [role]: { ...(p[role] || {}), [section]: level } }));
    setDirty(true);
  }
  function setRoleAll(role, level) {
    setPerms((p) => {
      const next = { ...(p[role] || {}) };
      for (const g of SECTION_GROUPS) for (const [k] of g.items) next[k] = level;
      return { ...p, [role]: next };
    });
    setDirty(true);
  }
  async function save() {
    setBusy(true);
    try {
      await api.put('/settings', { key: 'custom_roles', value: JSON.stringify(custom) });
      await api.put('/settings', { key: 'role_permissions', value: JSON.stringify(perms) });
      await refreshPermissions();
      setDirty(false);
    } finally { setBusy(false); }
  }
  function reset() { setPerms(defaults(custom)); setDirty(true); }

  if (!perms) return <div className="muted">Loading…</div>;

  const cellStyle = { padding: '6px 8px', textAlign: 'center' };
  const colour = (l) => l === 'edit' ? '#15803d' : l === 'view' ? '#b45309' : '#6b7280';

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="section-header">
        <div>
          <h2>Roles &amp; Permissions</h2>
          <div className="sub">What each role can see and change. Admin always has full access.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={reset} disabled={busy}>Reset to defaults</button>
          <button className="primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
        </div>
      </div>

      <div className="card col" style={{ gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Roles</h3>
          <div className="muted" style={{ fontSize: 12 }}>Admin always has full access and cannot be changed. Add your own roles (for example Senior Therapist), set what they see and do below, then assign staff to them in Admin → Staff.</div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {BUILTIN_ROLES.map(([k, label]) => (
            <span key={k} style={{ padding: '4px 10px', borderRadius: 999, background: 'rgba(13,27,62,0.08)', fontSize: 12, fontWeight: 700 }}>{label}</span>
          ))}
          {custom.map((r) => (
            <span key={r.key} style={{ padding: '4px 6px 4px 10px', borderRadius: 999, background: 'var(--gold)', color: 'var(--navy)', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {r.label}
              <button onClick={() => removeRole(r.key)} title="Remove this role"
                style={{ background: 'transparent', border: 'none', color: 'var(--navy)', fontWeight: 900, cursor: 'pointer', minHeight: 0, padding: '0 2px', fontSize: 14 }}>×</button>
            </span>
          ))}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input value={newRole} onChange={(e) => setNewRole(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRole(); }}
            placeholder="New role name, e.g. Senior Therapist" style={{ flex: 1, minWidth: 200 }} />
          <button onClick={addRole}>+ Add role</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 560 }}>
          <thead>
            <tr style={{ background: 'var(--navy)', color: 'white' }}>
              <th style={{ ...cellStyle, textAlign: 'left' }}>Section</th>
              <th style={cellStyle}>Admin</th>
              {ROLES.map(([r, label]) => (
                <th key={r} style={cellStyle}>
                  <div>{label}</div>
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 4 }}>
                    {LEVELS.map(([l, ll]) => (
                      <button key={l} onClick={() => setRoleAll(r, l)} title={`Set every section to "${ll}" for ${label}`}
                        style={{ fontSize: 10, padding: '2px 6px', minHeight: 22, background: 'rgba(255,255,255,0.12)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4 }}>
                        all {l}
                      </button>
                    ))}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SECTION_GROUPS.map((g) => (
              <React.Fragment key={g.title}>
                <tr><td colSpan={2 + ROLES.length} style={{ padding: '10px 8px 4px', fontWeight: 800, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>{g.title}</td></tr>
                {g.items.map(([k, label]) => (
                  <tr key={k} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...cellStyle, textAlign: 'left', fontWeight: 600 }}>{label}</td>
                    <td style={{ ...cellStyle, color: '#15803d', fontWeight: 700 }}>Full</td>
                    {ROLES.map(([r]) => {
                      const level = perms[r]?.[k] || 'none';
                      const opts = k === 'discounts' ? LEVELS.filter(([l]) => l !== 'view') : LEVELS;
                      return (
                        <td key={r} style={cellStyle}>
                          <select value={level} onChange={(e) => set(r, k, e.target.value)}
                            style={{ fontWeight: 700, color: colour(level), minHeight: 34, padding: '4px 6px' }}>
                            {opts.map(([l, ll]) => <option key={l} value={l}>{ll}</option>)}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {/* SPA-RBAC-002 — what a role may DO, not just see. */}
            <tr><td colSpan={2 + ROLES.length} style={{ padding: '10px 8px 4px', fontWeight: 800, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Actions</td></tr>
            {ACTIONS.map(([key, label]) => (
              <tr key={key} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...cellStyle, textAlign: 'left', fontWeight: 600 }}>
                  {label}
                  {key === 'manage_sessions' && (
                    <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>Admin only by default. Gift vouchers are not affected.</div>
                  )}
                </td>
                <td style={{ ...cellStyle, color: '#15803d', fontWeight: 700 }}>Yes</td>
                {ROLES.map(([r]) => (
                  <td key={r} style={cellStyle}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', minHeight: 34 }}>
                      <input type="checkbox" style={{ width: 20, height: 20, minHeight: 0 }}
                        checked={perms[r]?.[key] === 'on'}
                        onChange={(e) => set(r, key, e.target.checked ? 'on' : 'off')} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: perms[r]?.[key] === 'on' ? '#15803d' : '#6b7280' }}>
                        {perms[r]?.[key] === 'on' ? 'allowed' : 'no'}
                      </span>
                    </label>
                  </td>
                ))}
              </tr>
            ))}

            {/* SPA-HISTORY-LOCK-001 */}
            <tr><td colSpan={2 + ROLES.length} style={{ padding: '10px 8px 4px', fontWeight: 800, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)' }}>Historical data</td></tr>
            <tr style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ ...cellStyle, textAlign: 'left', fontWeight: 600 }}>
                Prevent editing past records
                <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>Past bookings, past rota days, bills of past days, back-dated petty cash become read-only. Today and the future stay editable.</div>
              </td>
              <td style={{ ...cellStyle, color: '#6b7280' }}>never</td>
              {ROLES.map(([r]) => (
                <td key={r} style={cellStyle}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', minHeight: 34 }}>
                    <input type="checkbox" style={{ width: 20, height: 20, minHeight: 0 }} checked={perms[r]?.history_lock === 'on'}
                      onChange={(e) => set(r, 'history_lock', e.target.checked ? 'on' : 'off')} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: perms[r]?.history_lock === 'on' ? '#b91c1c' : '#6b7280' }}>{perms[r]?.history_lock === 'on' ? '🔒 locked' : 'open'}</span>
                  </label>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <strong>Hidden</strong> removes the section from that role's Admin menu and blocks its API.{' '}
        <strong>View only</strong> shows the page but every control is switched off.{' '}
        <strong>View + edit</strong> is full access to that section.
        Staff need to log out and back in to see a change straight away (it also refreshes on its own within a minute).
        The Roles &amp; Permissions page itself is always admin-only.
      </div>
    </div>
  );
}
