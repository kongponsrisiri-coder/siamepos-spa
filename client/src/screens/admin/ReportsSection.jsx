import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function ReportsSection() {
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to,   setTo]   = useState(isoDaysAgo(0));
  const [data, setData] = useState(null);

  async function load() {
    const r = await api.get(`/reports/therapist?from=${from}&to=${to}`);
    setData(r);
  }
  useEffect(() => { load(); }, [from, to]); // eslint-disable-line

  return (
    <div className="col">
      <div className="row">
        <div><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Therapist breakdown</h3>
        {!data || data.therapists.length === 0 ? <div className="muted">No data.</div> : (
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
              {data.therapists.map((t) => (
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
