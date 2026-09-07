// SPA-RBAC-001 — Admin → Roles & Permissions (admin only).
// A matrix of admin sections × roles; each cell is Hidden / View only /
// View + edit. Saved as one JSON setting (role_permissions); the server
// enforces it on the API, the till uses it for the nav and read-only mode.
import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { SECTION_GROUPS, ROLES, LEVELS, defaults, refreshPermissions } from '../../permissions.js';

export default function PermissionsSection() {
  const [perms, setPerms] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy]   = useState(false);

  useEffect(() => {
    api.get('/permissions').then((r) => setPerms(r.permissions || defaults())).catch(() => setPerms(defaults()));
  }, []);

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
      await api.put('/settings', { key: 'role_permissions', value: JSON.stringify(perms) });
      await refreshPermissions();
      setDirty(false);
    } finally { setBusy(false); }
  }
  function reset() { setPerms(defaults()); setDirty(true); }

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
