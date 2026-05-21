// SPA-CRM-001 — Admin → Clients CRM dashboard.
// Mirrors the restaurant-epos CustomersSection pattern (status pills,
// search + filter, marketing-consent toggle, CSV export) but feeds off
// the spa's real clients + appointments + bills tables — so visits and
// spend are exact, not heuristic joins.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';

const STATUS_STYLE = {
  VIP:     { bg: '#ede9fe', color: '#5b21b6', icon: '⭐' },
  Regular: { bg: '#dbeafe', color: '#1e40af', icon: '🔁' },
  New:     { bg: '#dcfce7', color: '#166534', icon: '🆕' },
  Lapsed:  { bg: '#fee2e2', color: '#991b1b', icon: '😴' },
};

// SPA-003 — acquisition source pills. Treatwell + Direct are the two
// segments the owner targets in CRM ("convert Treatwell customers to
// direct"). Everything that isn't 'treatwell' counts as direct.
const SOURCE_STYLE = {
  treatwell: { label: '🌐 Treatwell', bg: '#fff7ed', color: '#c2410c' },
  online:    { label: '🪷 Widget',    bg: '#e0e7ff', color: '#3730a3' },
  walkin:    { label: '🚶 Walk-in',   bg: '#f3f4f6', color: '#374151' },
  staff:     { label: '🧑‍💼 Staff',    bg: '#f3f4f6', color: '#374151' },
  unknown:   { label: '— No visit',   bg: '#f3f4f6', color: '#9ca3af' },
};
function sourceStyle(src) { return SOURCE_STYLE[src] || SOURCE_STYLE.unknown; }

// Same thresholds as the EPOS CustomersSection so both products read the
// same to the operator.
function statusFor(visits, spend, daysSinceLast) {
  if (daysSinceLast != null && daysSinceLast > 60) return 'Lapsed';
  if (visits >= 5 || spend >= 200) return 'VIP';
  if (visits >= 2)                 return 'Regular';
  return 'New';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function downloadCsv(filename, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function ClientsSection() {
  const [clients, setClients]           = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sourceFilter, setSourceFilter] = useState('All');
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/clients');
      setClients(r.clients || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Decorate with computed fields (status + days since last visit).
  const decorated = useMemo(() => {
    const now = Date.now();
    return clients.map((c) => {
      const visits = Number(c.total_visits || 0);
      const spend  = Number(c.total_spend  || 0);
      const daysSinceLast = c.last_visit
        ? Math.floor((now - new Date(c.last_visit).getTime()) / 86400000)
        : null;
      return { ...c, visits, spend, daysSinceLast, status: statusFor(visits, spend, daysSinceLast) };
    });
  }, [clients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decorated.filter((c) => {
      if (statusFilter !== 'All' && c.status !== statusFilter) return false;
      if (sourceFilter !== 'All') {
        const src = c.acquisition_source || 'unknown';
        if (sourceFilter === 'direct') {
          // "direct" = anything that isn't Treatwell (walkin, online widget, staff)
          if (src === 'treatwell') return false;
        } else if (src !== sourceFilter) {
          return false;
        }
      }
      if (!q) return true;
      const hay = `${c.name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [decorated, search, statusFilter, sourceFilter]);

  const counts = useMemo(() => {
    const c = { VIP: 0, Regular: 0, New: 0, Lapsed: 0 };
    for (const x of decorated) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }, [decorated]);

  async function toggleConsent(client, next) {
    try {
      await api.put(`/clients/${client.id}`, { marketing_consent: next });
      // Optimistic local update, then reload to keep sort + stats in sync.
      setClients((list) => list.map((c) => c.id === client.id ? { ...c, marketing_consent: next } : c));
    } catch (e) { alert(e.message); }
  }

  function exportCsv() {
    const rows = [['Name', 'Email', 'Phone', 'Status', 'Source', 'Visits', 'First visit', 'Last visit', 'Total spend', 'Marketing consent', 'GDPR consent']];
    for (const c of filtered) {
      rows.push([
        c.name || '',
        c.email || '',
        c.phone || '',
        c.status,
        c.acquisition_source || '',
        c.visits,
        c.first_visit || '',
        c.last_visit  || '',
        c.spend.toFixed(2),
        c.marketing_consent ? 'Yes' : 'No',
        c.gdpr_consent      ? 'Yes' : 'No',
      ]);
    }
    const td = new Date();
    const stamp = `${td.getFullYear()}-${String(td.getMonth()+1).padStart(2,'0')}-${String(td.getDate()).padStart(2,'0')}`;
    downloadCsv(`spa-clients_${stamp}.csv`, rows);
  }

  const inputStyle = { padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' };

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Clients</h2>
          <div className="sub">CRM — visit history, consent and status segmentation</div>
        </div>
      </div>
      {/* ── Status tiles ───────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {['VIP', 'Regular', 'New', 'Lapsed'].map((s) => {
          const st = STATUS_STYLE[s];
          const active = statusFilter === s;
          return (
            <button key={s} onClick={() => setStatusFilter(active ? 'All' : s)} style={{
              background: active ? st.color : st.bg,
              color: active ? 'white' : st.color,
              border: 'none', borderRadius: 10, padding: '14px 16px',
              textAlign: 'left', cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, opacity: active ? 0.85 : 1 }}>
                {st.icon} {s}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{counts[s] || 0}</div>
            </button>
          );
        })}
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email or phone…"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
          <option value="All">All statuses</option>
          <option value="VIP">VIP</option>
          <option value="Regular">Regular</option>
          <option value="New">New</option>
          <option value="Lapsed">Lapsed</option>
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={inputStyle} title="Acquisition source — where this client first booked">
          <option value="All">All sources</option>
          <option value="treatwell">🌐 Treatwell</option>
          <option value="direct">Direct (not Treatwell)</option>
          <option value="online">🪷 Widget</option>
          <option value="walkin">🚶 Walk-in</option>
          <option value="staff">🧑‍💼 Staff-booked</option>
        </select>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button className="primary" onClick={exportCsv} disabled={!filtered.length}>
          ⬇ Export CSV
        </button>
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div className="card">
        {filtered.length === 0 ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
            {clients.length === 0
              ? 'No clients yet — they\'ll appear here once they book or are added from the Clients tab.'
              : 'No clients match the current filter.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ padding: '8px 6px' }}>Name</th>
                  <th style={{ padding: '8px 6px' }}>Contact</th>
                  <th style={{ padding: '8px 6px' }}>Status</th>
                  <th style={{ padding: '8px 6px' }}>Source</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Visits</th>
                  <th style={{ padding: '8px 6px' }}>First visit</th>
                  <th style={{ padding: '8px 6px' }}>Last visit</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Spend</th>
                  <th style={{ padding: '8px 6px' }}>Consent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const st = STATUS_STYLE[c.status];
                  return (
                    <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 6px', fontWeight: 600, color: '#1a1a2e' }}>
                        <button
                          onClick={() => navigate(`/clients/${c.id}`)}
                          style={{
                            background: 'none', border: 'none', padding: 0, color: '#1e3a6e',
                            fontWeight: 600, cursor: 'pointer', textAlign: 'left',
                            textDecoration: 'underline', textDecorationColor: 'rgba(30,58,110,0.25)',
                          }}
                        >{c.name || '—'}</button>
                      </td>
                      <td style={{ padding: '10px 6px', fontSize: 12, color: '#555' }}>
                        <div>{c.email || <span className="muted">no email</span>}</div>
                        {c.phone && <div className="muted">{c.phone}</div>}
                      </td>
                      <td style={{ padding: '10px 6px' }}>
                        <span style={{
                          background: st.bg, color: st.color,
                          padding: '3px 10px', borderRadius: 12,
                          fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                        }}>{st.icon} {c.status}</span>
                      </td>
                      <td style={{ padding: '10px 6px' }}>
                        {(() => {
                          const sst = sourceStyle(c.acquisition_source);
                          return (
                            <span style={{
                              background: sst.bg, color: sst.color,
                              padding: '3px 9px', borderRadius: 10,
                              fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                            }}>{sst.label}</span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 700 }}>{c.visits}</td>
                      <td style={{ padding: '10px 6px', color: '#555' }}>{fmtDate(c.first_visit)}</td>
                      <td style={{ padding: '10px 6px', color: '#555' }}>
                        {fmtDate(c.last_visit)}
                        {c.daysSinceLast != null && c.daysSinceLast >= 0 && (
                          <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                            {c.daysSinceLast === 0 ? 'today' : `${c.daysSinceLast}d ago`}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 700 }}>
                        £{c.spend.toFixed(2)}
                      </td>
                      <td style={{ padding: '10px 6px' }}>
                        {c.unsubscribed_at ? (
                          <span
                            style={{ background: '#fee2e2', color: '#991b1b', padding: '3px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700 }}
                            title={`Unsubscribed ${new Date(c.unsubscribed_at).toLocaleDateString('en-GB')}. Cannot be re-opted-in without a fresh, recorded consent.`}
                          >UNSUBSCRIBED</span>
                        ) : c.marketing_consent ? (
                          <button
                            onClick={() => toggleConsent(c, false)}
                            style={{ background: '#dcfce7', color: '#166534', padding: '3px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: 'none', cursor: 'pointer' }}
                            title="Click to opt out"
                          >OPTED IN</button>
                        ) : (
                          <button
                            onClick={() => toggleConsent(c, true)}
                            style={{ background: '#1e3a6e', color: '#C9A84C', padding: '3px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: 'none', cursor: 'pointer' }}
                            title="Only opt in when you have legitimate consent (verbal, signed, etc.)"
                          >+ Opt in</button>
                        )}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                        <button onClick={() => navigate(`/clients/${c.id}`)} style={{ fontSize: 12 }}>Open →</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
          Status: <strong>VIP</strong> = 5+ visits or £200+ lifetime ·{' '}
          <strong>Regular</strong> = 2–4 visits ·{' '}
          <strong>New</strong> = 1 visit ·{' '}
          <strong>Lapsed</strong> = no visit in 60+ days.
          Visits exclude cancelled and no-show appointments. Spend totals paid bills only.
          <br /><br />
          <strong>Acquisition source:</strong> where the client <em>first</em> reached the spa.{' '}
          <span style={{ background: '#fff7ed', color: '#c2410c', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>🌐 Treatwell</span>{' '}
          clients are the segment to convert to direct — filter by source, Export CSV, and send a "book direct, save 10%" offer through your email tool.
          <br /><br />
          <strong>Marketing consent:</strong> only{' '}
          <span style={{ background: '#dcfce7', color: '#166534', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>OPTED IN</span>{' '}
          clients should receive campaigns. Toggle off-widget consent (verbal, phone, walk-in) using the buttons above — never opt in without proof.
        </div>
      </div>
    </div>
  );
}
