import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
// Local-time YYYY-MM-DD — toISOString returns UTC, which rolls over to
// "tomorrow" between 23:00 and 00:00 local for any TZ ahead of UTC.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

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
      <div className="section-header">
        <div>
          <h2>Z Report</h2>
          <div className="sub">End-of-day revenue summary</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
          <button onClick={() => setDate(todayISO())}>Today</button>
        </div>
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
                <span>{m.payment_method === 'deposit' ? '🌐 deposit (online)' : (m.payment_method || '—')}</span>
                <span>{m.n} · {fmtMoney(m.revenue)}</span>
              </div>
            ))}
        </div>

        {/* SPA-PAY-001 — Stripe-side deposit movement for the day.
            'Taken' = new online bookings deposited today (sitting in
            Stripe, not the till). 'Consumed' = customer arrived + paid
            balance — already counted in by_payment_method above. The
            two views together give a full till + online picture. */}
        {data.online_deposits && (Number(data.online_deposits.count_pending) + Number(data.online_deposits.count_consumed) + Number(data.online_deposits.count_forfeit) > 0) && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
            <strong>🌐 Online deposits (Stripe)</strong>
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>Taken today</span>
              <span style={{ fontWeight: 700, color: '#C9A84C' }}>{fmtMoney(data.online_deposits.total_taken)}</span>
            </div>
            {Number(data.online_deposits.total_refunded) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span className="muted">Refunded</span>
                <span style={{ color: '#1e40af' }}>− {fmtMoney(data.online_deposits.total_refunded)}</span>
              </div>
            )}
            {Number(data.online_deposits.count_pending) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12, color: 'var(--muted)' }}>
                <span>Pending (booking upcoming)</span><span>{data.online_deposits.count_pending}</span>
              </div>
            )}
            {Number(data.online_deposits.count_consumed) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12, color: 'var(--muted)' }}>
                <span>Consumed (paid in full)</span><span>{data.online_deposits.count_consumed}</span>
              </div>
            )}
            {Number(data.online_deposits.count_forfeit) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12, color: '#92400e' }}>
                <span>Forfeit (late cancel)</span><span>{data.online_deposits.count_forfeit}</span>
              </div>
            )}
          </div>
        )}

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
