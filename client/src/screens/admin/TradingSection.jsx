import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

export default function TradingSection() {
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get(`/reports/trading?date=${date}`);
      setData(r);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [date]); // eslint-disable-line

  if (!data) return <div className="muted">{loading ? 'Loading…' : ''}</div>;

  const stat = (label, value) => (
    <div className="card" style={{ flex: 1, textAlign: 'center', minWidth: 140 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );

  return (
    <div className="col">
      <div className="row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 180 }} />
        <button onClick={() => setDate(todayISO())}>Today</button>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        {stat('Revenue',     fmtMoney(data.totals.revenue))}
        {stat('Tips',        fmtMoney(data.totals.tips))}
        {stat('Bills paid',  data.totals.bill_count)}
        {stat('Appointments', data.appointments.appt_count)}
        {stat('No-shows',    data.appointments.no_shows)}
        {stat('Cancelled',   data.appointments.cancelled)}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Top treatments</h3>
        {data.top_treatments.length === 0 ? <div className="muted">No bills yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Treatment</th>
                <th style={{ padding: '6px 4px' }}>Bookings</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.top_treatments.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 4px' }}>{t.name}</td>
                  <td style={{ padding: '6px 4px' }}>{t.bookings}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{fmtMoney(t.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>By payment method</h3>
        {data.by_payment_method.length === 0 ? <div className="muted">—</div> :
          data.by_payment_method.map((m) => (
            <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{m.payment_method || '—'}</span>
              <span>{m.n} · {fmtMoney(m.revenue)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
