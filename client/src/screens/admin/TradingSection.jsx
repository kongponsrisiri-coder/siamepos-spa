import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Coloured stat card — value big on top, label below (matches SiamEPOS pattern)
function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid var(--border)',
      borderTop: `3px solid ${color}`,
      borderRadius: 'var(--radius)',
      padding: '18px 16px 14px',
      flex: 1,
      minWidth: 130,
      boxShadow: 'var(--shadow-sm)',
      textAlign: 'center',
    }}>
      <div style={{
        fontSize: 28,
        fontWeight: 800,
        color: color,
        fontFamily: 'Inter, sans-serif',
        lineHeight: 1,
        letterSpacing: '-0.5px',
      }}>{value}</div>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginTop: 7,
      }}>{label}</div>
    </div>
  );
}

// Brand-CI colour palette for each metric
const COLORS = {
  revenue:      '#C9A84C',   /* gold */
  tips:         '#0891b2',   /* teal */
  bills:        '#0D1B3E',   /* brand navy */
  appointments: '#7c3aed',   /* violet */
  noshows:      '#f59e0b',   /* amber */
  cancelled:    '#ef4444',   /* red */
};

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

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Trading</h2>
          <div className="sub">Daily revenue and appointment summary</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
          <button onClick={() => setDate(todayISO())}>Today</button>
        </div>
      </div>

      {/* Spa identity header — same pattern as Z-Report so print /
          PDF / screenshots all carry the business name. */}
      {data.identity?.spa_name && (
        <div style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 700, color: '#1e3a6e', letterSpacing: '0.02em' }}>
            {data.identity.spa_name}
          </div>
          {(data.identity.spa_address || data.identity.spa_phone) && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {[data.identity.spa_address, data.identity.spa_phone].filter(Boolean).join(' · ')}
            </div>
          )}
          {data.identity.spa_email && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{data.identity.spa_email}</div>
          )}
        </div>
      )}

      {/* ── Stat cards ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <StatCard label="Revenue"      value={fmtMoney(data.totals.revenue)}          color={COLORS.revenue} />
        <StatCard label="Tips"         value={fmtMoney(data.totals.tips)}             color={COLORS.tips} />
        <StatCard label="Bills Paid"   value={data.totals.bill_count}                 color={COLORS.bills} />
        <StatCard label="Appointments" value={data.appointments.appt_count}           color={COLORS.appointments} />
        <StatCard label="No-Shows"     value={data.appointments.no_shows}             color={COLORS.noshows} />
        <StatCard label="Cancelled"    value={data.appointments.cancelled}            color={COLORS.cancelled} />
      </div>

      {/* ── Top treatments ─────────────────────────────────────── */}
      <div className="card col">
        <h3>Top treatments</h3>
        {data.top_treatments.length === 0 ? (
          <div className="muted">No bills yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Treatment</th>
                <th>Bookings</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.top_treatments.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.bookings}</td>
                  <td style={{ textAlign: 'right' }}>{fmtMoney(t.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── By payment method ──────────────────────────────────── */}
      <div className="card col">
        <h3>By payment method</h3>
        {data.by_payment_method.length === 0 ? (
          <div className="muted">—</div>
        ) : (
          data.by_payment_method.map((m) => (
            <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{m.payment_method || '—'}</span>
              <span style={{ fontWeight: 600 }}>{m.n} · {fmtMoney(m.revenue)}</span>
            </div>
          ))
        )}
      </div>

      {/* ── Online deposits (SPA-PAY-001) ──────────────────────────
          Money landed in the spa's Stripe account when customers booked
          online today. Pending = deposit attached to upcoming booking.
          Consumed = customer arrived + paid the balance at the till.
          Tracked separately because Stripe settles to the spa's bank
          on its own cycle, not via the till. */}
      {data.online_deposits && (Number(data.online_deposits.count_pending) + Number(data.online_deposits.count_consumed) + Number(data.online_deposits.count_forfeit) > 0) && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>🌐 Online deposits</h3>
            <span className="muted" style={{ fontSize: 12 }}>Settled to Stripe, not the till</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
            <span>Taken today</span>
            <span style={{ fontWeight: 700, color: '#C9A84C', fontSize: 18 }}>{fmtMoney(data.online_deposits.total_taken)}</span>
          </div>
          {Number(data.online_deposits.total_refunded) > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span className="muted">Refunded</span>
              <span style={{ color: '#1e40af' }}>− {fmtMoney(data.online_deposits.total_refunded)}</span>
            </div>
          )}
          <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
            {Number(data.online_deposits.count_pending) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
                <span className="muted">Pending (booking upcoming)</span>
                <span>{data.online_deposits.count_pending}</span>
              </div>
            )}
            {Number(data.online_deposits.count_consumed) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
                <span className="muted">Consumed (customer paid balance)</span>
                <span>{data.online_deposits.count_consumed}</span>
              </div>
            )}
            {Number(data.online_deposits.count_forfeit) > 0 && (
              <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
                <span className="muted">Forfeit (late cancel)</span>
                <span style={{ color: '#92400e' }}>{data.online_deposits.count_forfeit}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Voucher sales (deferred revenue) ───────────────────────
          Tracked separately from bill revenue: vouchers are money
          received but not yet earned (service hasn't been delivered).
          Helps the owner reconcile the till at end of day without
          double-counting voucher cash as earned revenue. */}
      {data.voucher_sales && data.voucher_sales.count > 0 && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>🎁 Voucher sales</h3>
            <span className="muted" style={{ fontSize: 12 }}>Deferred revenue — money in, service to come</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
            <span><strong>{data.voucher_sales.count}</strong> voucher{data.voucher_sales.count === 1 ? '' : 's'} sold today</span>
            <span style={{ fontWeight: 700, color: '#C9A84C' }}>{fmtMoney(data.voucher_sales.total)}</span>
          </div>
          {data.voucher_sales.by_payment_method?.length > 0 && (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              {data.voucher_sales.by_payment_method.map((m) => (
                <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                  <span className="muted">{m.payment_method}</span>
                  <span>{m.n} · {fmtMoney(m.revenue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
