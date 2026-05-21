import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
// Local-time YYYY-MM-DD. setDate is local; toISOString is UTC — mixing
// the two produces an off-by-one day near midnight for any TZ ahead of
// UTC. Read with local component getters throughout to stay consistent.
function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// SPA-003 — source labels mirror ClientsSection's pills so reports +
// CRM read the same way to the operator.
const SOURCE_LABEL = {
  treatwell: { label: '🌐 Treatwell', bg: '#fff7ed', color: '#c2410c' },
  online:    { label: '🪷 Widget',    bg: '#e0e7ff', color: '#3730a3' },
  walkin:    { label: '🚶 Walk-in',   bg: '#f3f4f6', color: '#374151' },
  staff:     { label: '🧑‍💼 Staff',    bg: '#f3f4f6', color: '#374151' },
  unknown:   { label: '— Unknown',    bg: '#f3f4f6', color: '#9ca3af' },
};

export default function ReportsSection() {
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to,   setTo]   = useState(isoDaysAgo(0));
  const [therapistData, setTherapistData] = useState(null);
  const [trading,       setTrading]       = useState(null);

  async function load() {
    const [t, td] = await Promise.all([
      api.get(`/reports/therapist?from=${from}&to=${to}`),
      api.get(`/reports/trading?date=${to}`),
    ]);
    setTherapistData(t);
    setTrading(td);
  }
  useEffect(() => { load(); }, [from, to]); // eslint-disable-line

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Reports</h2>
          <div className="sub">Therapist performance and trading analysis</div>
        </div>
      </div>
      <div className="row">
        <div><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>

      {/* SPA-003 — source breakdown for the To date. Treatwell vs direct
          booking + revenue split, so the owner can see how much of today
          came in via the marketplace vs straight to them. */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Booking source — {to}</h3>
          <span className="muted" style={{ fontSize: 12 }}>Where today's bookings came from</span>
        </div>
        {!trading || !trading.by_source || trading.by_source.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>No bookings on this date.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginTop: 12 }}>
            {trading.by_source.map((row) => {
              const meta = SOURCE_LABEL[row.source] || SOURCE_LABEL.unknown;
              return (
                <div key={row.source} style={{
                  background: meta.bg,
                  color: meta.color,
                  borderRadius: 10,
                  padding: '14px 16px',
                  border: `1px solid ${meta.color}22`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                    {meta.label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>
                    {row.appointments} <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.7 }}>bookings</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4, opacity: 0.85 }}>
                    {fmtMoney(row.revenue)} revenue
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
          Treatwell revenue is the menu price — Treatwell settles to you minus commission. Use Admin → Clients → filter <strong>🌐 Treatwell</strong> → Export CSV to target these customers with a direct-booking offer.
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Therapist breakdown</h3>
        {!therapistData || therapistData.therapists.length === 0 ? <div className="muted">No data.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Therapist</th>
                <th style={{ padding: '6px 4px' }}>Bills</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Revenue</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Tips</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {therapistData.therapists.map((t) => (
                <tr key={t.id || 'none'} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 4px' }}>{t.name || '— (unassigned)'}</td>
                  <td style={{ padding: '6px 4px' }}>{t.bills}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{fmtMoney(t.revenue)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{fmtMoney(t.tips)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(t.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
