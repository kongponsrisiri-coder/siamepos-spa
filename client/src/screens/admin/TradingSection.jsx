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
        fontFamily: 'system-ui, -apple-system, sans-serif',
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

// Payment-method labels for the two-group breakdown.
const PM_LABEL = { card: '💳 Card', cash: '💵 Cash', treatwell: '🌐 Treatwell', online: '🌐 Online prepayment', split: '⇄ Split', voucher: '🎁 Voucher' };
const AP_LABEL = { voucher: '🎁 Voucher redeemed', external: '🧾 Already paid (external)', deposit: '🌐 Deposit (prepaid online)' };

// SPA-DEPOSIT-CLARITY-001 — status chip per deposit row on the Trading card.
const DEP_CHIP = {
  deposit_paid: { label: 'visit upcoming',              bg: '#dbeafe', color: '#1e40af' },
  fully_paid:   { label: 'visited · settled',           bg: '#dcfce7', color: '#166534' },
  forfeit:      { label: 'late cancel · deposit kept',  bg: '#fef3c7', color: '#92400e' },
  refunded:     { label: 'refunded',                    bg: '#e2e8f0', color: '#475569' },
};

// Brand-CI colour palette for each metric
const COLORS = {
  revenue:      'var(--gold)',   /* gold */
  tips:         '#0891b2',   /* teal */
  bills:        'var(--navy)',   /* brand navy */
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

      {/* ── By payment method — money taken today (= revenue) ──── */}
      {(() => {
        const pb = data.payment_breakdown || { money_taken: data.by_payment_method || [], already_paid: [] };
        return (
          <>
            <div className="card col">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3 style={{ margin: 0 }}>By payment method</h3>
                <span className="muted" style={{ fontSize: 12 }}>Money taken today</span>
              </div>
              {pb.money_taken.length === 0 ? <div className="muted">—</div> : (
                <>
                  {pb.money_taken.map((m) => (
                    <div key={m.payment_method} style={{ padding: '4px 0' }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>{PM_LABEL[m.payment_method] || m.payment_method}</span>
                        <span style={{ fontWeight: 600 }}>{m.n} · {fmtMoney(m.revenue)}</span>
                      </div>
                      {Number(m.voucher_portion) > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>incl. {fmtMoney(m.voucher_portion)} voucher sales</div>
                      )}
                    </div>
                  ))}
                  <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2, fontWeight: 700 }}>
                    <span>Total revenue</span><span style={{ color: 'var(--gold)' }}>{fmtMoney(data.totals.revenue)}</span>
                  </div>
                </>
              )}
            </div>

            {/* ── Covered by an earlier payment (not counted again today) ── */}
            {pb.already_paid && pb.already_paid.length > 0 && (
              <div className="card col">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <h3 style={{ margin: 0 }}>Covered by an earlier payment</h3>
                  <span className="muted" style={{ fontSize: 12 }}>Not counted in today's revenue</span>
                </div>
                {pb.already_paid.map((m) => (
                  <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                    <span>{AP_LABEL[m.payment_method] || m.payment_method}</span>
                    <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{m.n} · {fmtMoney(m.amount)}</span>
                  </div>
                ))}
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  This money already came in — when the voucher was sold, paid online, or before SiamEPOS — so it isn't added to today's revenue again.
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ── Expenses / petty cash (SPA-PETTYCASH-001) ──────────────
          Cash paid OUT of the drawer today. Read-only here — entries are
          added/removed on the Z-Report tab. Net cash mirrors the Z report:
          cash physically taken − expenses paid out. */}
      {data.petty_cash && data.petty_cash.count > 0 && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>💸 Expenses (petty cash)</h3>
            <span className="muted" style={{ fontSize: 12 }}>Cash paid out of the drawer</span>
          </div>
          {data.petty_cash.entries.map((p) => (
            <div key={p.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{p.reason}{p.staff_name ? <span className="muted" style={{ fontSize: 11 }}> · {p.staff_name}</span> : null}</span>
              <span style={{ fontWeight: 600, color: '#ef4444' }}>− {fmtMoney(p.amount)}</span>
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2, fontWeight: 700 }}>
            <span>Total expenses{data.petty_cash.count > 1 ? ` (${data.petty_cash.count})` : ''}</span>
            <span style={{ color: '#ef4444' }}>− {fmtMoney(data.petty_cash.total)}</span>
          </div>
          {data.cash_reconciliation && (
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
              <span className="muted">Net cash in drawer (cash taken {fmtMoney(data.cash_reconciliation.cash_taken)} − expenses)</span>
              <span style={{ fontWeight: 700 }}>{fmtMoney(data.cash_reconciliation.net_cash)}</span>
            </div>
          )}
          <div className="muted" style={{ fontSize: 11 }}>
            Add or remove expense entries on the Z-Report tab.
          </div>
        </div>
      )}

      {/* ── Online deposit money (SPA-PAY-001 + SPA-DEPOSIT-CLARITY-001) ──
          Money lands in the spa's Stripe account on the day the customer
          BOOKS; the visit is often a different day. This card tells both
          halves of that story — deposits RECEIVED this day (each tied to
          its visit date) and deposits already attached to this day's diary
          that were paid earlier — so a prepaid visit never reads as
          missing money (the Highbury 15 Aug scare). */}
      {data.online_deposits && (
        Number(data.online_deposits.total_taken) > 0 ||
        Number(data.online_deposits.total_refunded) > 0 ||
        Number(data.online_deposits.diary_prepaid?.count || 0) > 0) && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>🌐 Online deposit money</h3>
            <span className="muted" style={{ fontSize: 12 }}>Paid straight to Stripe — never through the till drawer</span>
          </div>
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: '#1e3a8a' }}>
            💡 Deposit money counts on the day the customer <strong>books</strong>, not the day they visit. If a visit and its money seem to be on different days — that's correct, nothing is missing.
          </div>

          <div className="row" style={{ justifyContent: 'space-between', padding: '8px 0 2px' }}>
            <span style={{ fontWeight: 700 }}>Received this day</span>
            <span style={{ fontWeight: 700, color: 'var(--gold)', fontSize: 18 }}>{fmtMoney(data.online_deposits.total_taken)}</span>
          </div>
          {(data.online_deposits.rows || []).map((r) => {
            const chip = DEP_CHIP[r.payment_status] || DEP_CHIP.deposit_paid;
            const sameDay = String(r.starts_at).slice(0, 10) === date;
            const visitLabel = (sameDay ? 'visit this day ' : 'visit ') + new Date(r.starts_at).toLocaleString('en-GB', {
              ...(sameDay ? {} : { weekday: 'short', day: '2-digit', month: 'short' }),
              hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
            });
            const refunded = r.payment_status === 'refunded';
            return (
              <div key={r.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 13, gap: 8 }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.client_name || 'Online booking'} <span className="muted">· {visitLabel}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: chip.bg, color: chip.color, whiteSpace: 'nowrap' }}>{chip.label}</span>
                  <span style={{ fontWeight: 600, fontFamily: 'monospace', color: refunded ? '#475569' : 'inherit', textDecoration: refunded ? 'line-through' : 'none' }}>
                    {fmtMoney(r.deposit_amount)}
                  </span>
                </span>
              </div>
            );
          })}
          {Number(data.online_deposits.total_refunded) > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
              <span className="muted">Refunded back to customers</span>
              <span style={{ color: '#1e40af' }}>− {fmtMoney(data.online_deposits.total_refunded)}</span>
            </div>
          )}

          {Number(data.online_deposits.diary_prepaid?.count || 0) > 0 && (
            <div style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 700 }}>On this day's diary, paid earlier</span>
                <span style={{ fontWeight: 700 }}>{data.online_deposits.diary_prepaid.count} · {fmtMoney(data.online_deposits.diary_prepaid.total)}</span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Each of these was paid on the customer's booking day — the money is in that day's report, so it won't appear in this day's takings. When the bill is settled it shows under "Covered by an earlier payment".
              </div>
            </div>
          )}
        </div>
      )}

      {/* Voucher sales are now folded into the card/cash lines above (with an
          "incl. voucher sales" note), so we just show the count for context. */}
      {data.voucher_sales && data.voucher_sales.count > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          🎁 {data.voucher_sales.count} voucher{data.voucher_sales.count === 1 ? '' : 's'} sold today ({fmtMoney(data.voucher_sales.total)}) — included in the card/cash totals above.
        </div>
      )}
    </div>
  );
}
