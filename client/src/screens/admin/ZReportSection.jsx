import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

export default function ZReportSection() {
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get(`/reports/z-report?date=${date}`);
    setData(r);
  }, [date]);

  useEffect(() => { load(); }, [load]);

  async function closeDay() {
    if (!confirm(`Close Z report for ${date}? This stamps the day as closed.`)) return;
    setBusy(true);
    try {
      await api.post('/reports/z-report/close', { date });
      await load();
    } finally { setBusy(false); }
  }

  if (!data) return <div className="muted">Loading…</div>;
  const closed = data.last_closed_date === date;

  return (
    <div className="col">
      <div className="row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 180 }} />
        <button onClick={() => setDate(todayISO())}>Today</button>
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Z Report — {date}</h3>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Subtotal</span><span>{fmtMoney(data.totals.subtotal)}</span></div>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Tips</span><span>{fmtMoney(data.totals.tips)}</span></div>
        <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8, fontWeight: 600 }}>
          <span>Total ({data.totals.bills} bills)</span><span>{fmtMoney(data.totals.total)}</span>
        </div>

        <div>
          <strong>By payment method</strong>
          {data.by_payment_method.length === 0 ? <div className="muted">—</div> :
            data.by_payment_method.map((m) => (
              <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{m.payment_method || '—'}</span>
                <span>{m.n} · {fmtMoney(m.revenue)}</span>
              </div>
            ))}
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {data.last_closed_date ? `Last closed: ${data.last_closed_date}` : 'Never closed'}
          </span>
          <button className="primary" onClick={closeDay} disabled={busy || closed}>
            {closed ? 'Already closed' : busy ? 'Closing…' : 'Close Z report'}
          </button>
        </div>
      </div>
    </div>
  );
}
