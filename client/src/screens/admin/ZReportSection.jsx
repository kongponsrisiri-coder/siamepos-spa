import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
const KIND_LABEL = { treatment: '💆 Treatments', retail: '🛍 Products', addon: '➕ Add-ons' };
const PM_LABEL = { card: '💳 Card', cash: '💵 Cash', treatwell: '🌐 Treatwell', online: '🌐 Online prepayment', split: '⇄ Split', voucher: '🎁 Voucher' };
const AP_LABEL = { voucher: '🎁 Voucher redeemed', external: '🧾 Already paid (external)', deposit: '🌐 Deposit (prepaid online)' };
// Local-time YYYY-MM-DD — toISOString returns UTC, which rolls over to
// "tomorrow" between 23:00 and 00:00 local for any TZ ahead of UTC.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Quote a CSV cell — escape double-quotes, wrap in quotes if the value
// contains comma / quote / newline. Safe for Excel + Numbers.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ZReportSection() {
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState(null);
  const [bills, setBills] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // Pull summary + line-by-line bills together so the export has both.
    const [r, bs] = await Promise.all([
      api.get(`/reports/z-report?date=${date}`),
      api.get(`/bills?from=${date}&to=${date}`),
    ]);
    setData(r);
    setBills(bs.bills || []);
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

  // SPA-PAY-001 — CSV export. One row per bill closed that day, with
  // the underlying split rows broken out into per-method columns so an
  // accountant can sum cash / card / voucher / deposit straight off the
  // sheet. Summary block follows the detail rows.
  function exportCsv() {
    if (!data || bills.length === 0) {
      alert('No bills closed on this date — nothing to export.');
      return;
    }
    const METHODS = ['cash', 'card', 'voucher', 'deposit', 'treatwell'];
    const header = [
      'Date', 'Time', 'Bill #', 'Client', 'Treatment',
      'Subtotal £', 'Tip £', 'Total £',
      'Method',
      ...METHODS.map((m) => `${m[0].toUpperCase()}${m.slice(1)} £`),
      'Status',
    ];
    const rows = [];
    // Shop identity header for the CSV
    if (data.identity?.spa_name) rows.push([data.identity.spa_name]);
    if (data.identity?.spa_address) rows.push([data.identity.spa_address]);
    if (data.identity?.spa_phone || data.identity?.spa_email) {
      rows.push([[data.identity.spa_phone, data.identity.spa_email].filter(Boolean).join(' · ')]);
    }
    rows.push([`Z Report — ${date}`]);
    rows.push([]);
    rows.push(header);

    // Per-bill detail rows
    for (const b of bills) {
      const closed = new Date(b.closed_at);
      const breakdown = Object.fromEntries(METHODS.map((m) => [m, 0]));
      if (b.payment_method === 'split' && Array.isArray(b.split_payments)) {
        for (const p of b.split_payments) {
          if (breakdown[p.method] !== undefined) breakdown[p.method] += Number(p.amount || 0);
        }
      } else if (METHODS.includes(b.payment_method)) {
        breakdown[b.payment_method] = Number(b.total || 0);
      }
      rows.push([
        date,
        closed.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        b.id,
        b.client_name || 'Walk-in',
        b.treatment_name || '',
        Number(b.subtotal || 0).toFixed(2),
        Number(b.tip || 0).toFixed(2),
        Number(b.total || 0).toFixed(2),
        b.payment_method || '',
        ...METHODS.map((m) => breakdown[m] > 0 ? breakdown[m].toFixed(2) : ''),
        b.payment_status || '',
      ]);
    }

    // Blank separator
    rows.push([]);
    // Summary block
    rows.push(['Summary']);
    rows.push(['', '', '', '', '',
      Number(data.totals.subtotal || 0).toFixed(2),
      Number(data.totals.tips || 0).toFixed(2),
      Number(data.totals.total || 0).toFixed(2),
      `${data.totals.bills} bills`,
    ]);
    rows.push([]);
    rows.push(['By payment method', 'Count', 'Revenue £']);
    for (const m of data.by_payment_method || []) {
      rows.push([m.payment_method, m.n, Number(m.revenue).toFixed(2)]);
    }

    // SPA-BILL-ITEMS — revenue-by-type + VAT split for the accountant.
    if (Array.isArray(data.by_kind) && data.by_kind.length > 0) {
      rows.push([]);
      rows.push(['Revenue by type', 'Lines', 'Gross £', 'Net £', 'VAT £']);
      for (const k of data.by_kind) {
        rows.push([KIND_LABEL[k.kind] || k.kind, k.lines, Number(k.gross).toFixed(2), Number(k.net).toFixed(2), Number(k.vat).toFixed(2)]);
      }
    }
    if (data.vat) {
      rows.push([]);
      rows.push([`VAT (prices incl. VAT @ ${Number(data.vat.rate)}%)`]);
      rows.push(['Net sales (ex-VAT, ex-tips)', '', Number(data.vat.net).toFixed(2)]);
      rows.push([`VAT @ ${Number(data.vat.rate)}%`, '', Number(data.vat.vat).toFixed(2)]);
      rows.push(['Gross (ex-tips)', '', Number(data.vat.gross).toFixed(2)]);
    }
    if (data.online_deposits) {
      rows.push([]);
      rows.push(['Online deposits (Stripe)']);
      rows.push(['Taken today',     '', Number(data.online_deposits.total_taken    || 0).toFixed(2)]);
      rows.push(['Refunded',        '', Number(data.online_deposits.total_refunded || 0).toFixed(2)]);
      rows.push(['Pending (upcoming)',     data.online_deposits.count_pending  || 0]);
      rows.push(['Consumed (paid in full)', data.online_deposits.count_consumed || 0]);
      rows.push(['Forfeit (late cancel)',  data.online_deposits.count_forfeit || 0]);
    }

    // Voucher sales — deferred revenue, listed separately from bill totals
    if (data.voucher_sales && Number(data.voucher_sales.count) > 0) {
      rows.push([]);
      rows.push(['Voucher sales']);
      rows.push(['Count', data.voucher_sales.count]);
      rows.push(['Total £', '', Number(data.voucher_sales.total).toFixed(2)]);
      if (Array.isArray(data.voucher_sales.by_payment_method)) {
        for (const m of data.voucher_sales.by_payment_method) {
          rows.push([`  ${m.payment_method}`, m.n, Number(m.revenue).toFixed(2)]);
        }
      }
    }

    downloadCsv(`z-report_${date}.csv`, rows);
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
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
          <button onClick={() => setDate(todayISO())}>Today</button>
          <button onClick={exportCsv} disabled={!data || bills.length === 0} title="Download line-by-line CSV with split breakdown + summary">📥 Export CSV</button>
          <button onClick={() => window.print()} title="Print-friendly view of this Z report">🖨 Print</button>
        </div>
      </div>
      <div className="card col">
        {/* Shop identity — top of every Z report so the printout / CSV
            carry the business name. */}
        {data.identity?.spa_name && (
          <div style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 6 }}>
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
        <h3 style={{ margin: 0 }}>Z Report — {date}</h3>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Subtotal</span><span>{fmtMoney(data.totals.subtotal)}</span></div>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Tips</span><span>{fmtMoney(data.totals.tips)}</span></div>
        <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8, fontWeight: 600 }}>
          <span>Total ({data.totals.bills} bills)</span><span>{fmtMoney(data.totals.total)}</span>
        </div>

        {(() => {
          const pb = data.payment_breakdown || { money_taken: data.by_payment_method || [], already_paid: [] };
          return (
            <>
              <div>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong>By payment method</strong>
                  <span className="muted" style={{ fontSize: 12 }}>Money taken</span>
                </div>
                {pb.money_taken.length === 0 ? <div className="muted">—</div> :
                  pb.money_taken.map((m) => (
                    <div key={m.payment_method} style={{ padding: '4px 0' }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>{PM_LABEL[m.payment_method] || m.payment_method}</span>
                        <span>{m.n} · {fmtMoney(m.revenue)}</span>
                      </div>
                      {Number(m.voucher_portion) > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>incl. {fmtMoney(m.voucher_portion)} voucher sales</div>
                      )}
                    </div>
                  ))}
              </div>
              {pb.already_paid && pb.already_paid.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong>Covered by an earlier payment</strong>
                    <span className="muted" style={{ fontSize: 12 }}>Not in today's revenue</span>
                  </div>
                  {pb.already_paid.map((m) => (
                    <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                      <span>{AP_LABEL[m.payment_method] || m.payment_method}</span>
                      <span style={{ color: 'var(--muted)' }}>{m.n} · {fmtMoney(m.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          );
        })()}

        {/* SPA-BILL-ITEMS — revenue split by line-item type (treatment vs
            retail products vs add-ons) so the owner sees how much came from
            product sales / upgrades rather than treatments. */}
        {Array.isArray(data.by_kind) && data.by_kind.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
            <strong>Revenue by type</strong>
            {data.by_kind.map((k) => (
              <div key={k.kind} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{KIND_LABEL[k.kind] || k.kind}</span>
                <span>{k.lines} · {fmtMoney(k.gross)}</span>
              </div>
            ))}
          </div>
        )}

        {/* SPA-BILL-ITEMS — VAT breakdown. Prices are VAT-inclusive; VAT is
            charged on goods/services taken (total minus tips). */}
        {data.vat && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
            <strong>VAT (incl. in prices · {Number(data.vat.rate)}%)</strong>
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>Net sales (ex-VAT, ex-tips)</span><span>{fmtMoney(data.vat.net)}</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>VAT @ {Number(data.vat.rate)}%</span><span>{fmtMoney(data.vat.vat)}</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0', fontWeight: 600 }}>
              <span>Gross (ex-tips)</span><span>{fmtMoney(data.vat.gross)}</span>
            </div>
            {Array.isArray(data.by_kind) && data.by_kind.length > 1 && (
              <div style={{ paddingTop: 6, marginTop: 2, borderTop: '1px solid #f3f4f6' }}>
                {data.by_kind.map((k) => (
                  <div key={k.kind} className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12, color: 'var(--muted)' }}>
                    <span>{KIND_LABEL[k.kind] || k.kind} — net {fmtMoney(k.net)}</span>
                    <span>VAT {fmtMoney(k.vat)}</span>
                  </div>
                ))}
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  Per-type VAT is on list prices; any whole-bill discount is reflected in the headline VAT above.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Voucher sales — money received today against vouchers, which
            is deferred revenue (service to come). Tracked separately
            from bill revenue so the operator doesn't double-count
            voucher cash at end of day. */}
        {data.voucher_sales && Number(data.voucher_sales.count) > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
            <strong>🎁 Voucher sales</strong>
            <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{data.voucher_sales.count} voucher{Number(data.voucher_sales.count) === 1 ? '' : 's'} sold</span>
              <span style={{ fontWeight: 700, color: '#16a34a' }}>{fmtMoney(data.voucher_sales.total)}</span>
            </div>
            {Array.isArray(data.voucher_sales.by_payment_method) && data.voucher_sales.by_payment_method.length > 0 && (
              <div style={{ paddingTop: 4, borderTop: '1px solid #f3f4f6' }}>
                {data.voucher_sales.by_payment_method.map((m) => (
                  <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12, color: 'var(--muted)' }}>
                    <span>{m.payment_method}</span>
                    <span>{m.n} · {fmtMoney(m.revenue)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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

      {/* Bills detail — gives the operator a scannable on-screen view
          and feeds the print preview. The CSV export uses the same
          underlying rows. */}
      {bills.length > 0 && (
        <div className="card col">
          <h3 style={{ margin: 0 }}>Bills closed — {date}</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ padding: '6px' }}>Time</th>
                  <th style={{ padding: '6px' }}>#</th>
                  <th style={{ padding: '6px' }}>Client</th>
                  <th style={{ padding: '6px' }}>Treatment</th>
                  <th style={{ padding: '6px', textAlign: 'right' }}>Subtotal</th>
                  <th style={{ padding: '6px', textAlign: 'right' }}>Tip</th>
                  <th style={{ padding: '6px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '6px' }}>Method</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>{new Date(b.closed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--muted)' }}>{b.id}</td>
                    <td style={{ padding: '8px 6px' }}>{b.client_name || <span className="muted">Walk-in</span>}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--muted)' }}>{b.treatment_name || '—'}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtMoney(b.subtotal)}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', color: b.tip > 0 ? 'var(--success)' : 'var(--muted)' }}>{fmtMoney(b.tip)}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{fmtMoney(b.total)}</td>
                    <td style={{ padding: '8px 6px' }}>
                      {b.payment_method || '—'}
                      {b.payment_method === 'split' && Array.isArray(b.split_payments) && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                          {b.split_payments.map((p, i) => (
                            <div key={i}>{p.method} £{Number(p.amount).toFixed(2)}</div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
