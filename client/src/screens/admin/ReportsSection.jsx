import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtMins(n) {
  const m = Number(n || 0);
  if (m <= 0) return '—';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return rem + 'm';
  if (rem === 0) return h + 'h';
  return h + 'h ' + rem + 'm';
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function startOfWeek() {
  const d = new Date();
  // Monday = 1, Sunday = 0 — UK week starts Monday
  const dayIdx = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayIdx);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function startOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

const SOURCE_LABEL = {
  treatwell: { label: '🌐 Treatwell', bg: '#fff7ed', color: '#c2410c' },
  online:    { label: '🪷 Widget',    bg: '#e0e7ff', color: '#3730a3' },
  walkin:    { label: '🚶 Walk-in',   bg: '#f3f4f6', color: '#374151' },
  staff:     { label: '🧑‍💼 Staff',    bg: '#f3f4f6', color: '#374151' },
  unknown:   { label: '— Unknown',    bg: '#f3f4f6', color: '#9ca3af' },
};

const METHOD_STYLE = {
  cash:      { color: '#9a3412', label: '💵 Cash' },
  card:      { color: '#9d174d', label: '💳 Card' },
  voucher:   { color: '#14532d', label: '🎁 Voucher' },
  deposit:   { color: '#1e3a6e', label: '🌐 Deposit (prepaid online)' },
  treatwell: { color: '#854d0e', label: '🌐 Treatwell' },
  split:     { color: '#4c1d95', label: '⇄ Split' },
  online:    { color: '#0891b2', label: '🌐 Online prepayment' },
  external:  { color: '#334155', label: '🧾 Already paid (external)' },
  unknown:   { color: '#6b7280', label: '— Unknown' },
};
const AP_LABEL = { voucher: '🎁 Voucher redeemed', external: '🧾 Already paid (external)', deposit: '🌐 Deposit (prepaid online)' };

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

export default function ReportsSection() {
  // SPA-REPORTS-V2 — default to today, not 30 days back. Korakot wants
  // the operator to land on "what's happening now" by default and
  // change to a range only when needed.
  const [from, setFrom] = useState(todayISO());
  const [to,   setTo]   = useState(todayISO());
  const [therapistData, setTherapistData] = useState(null);
  const [trading,       setTrading]       = useState(null);
  const [loading,       setLoading]       = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, td] = await Promise.all([
        api.get(`/reports/therapist?from=${from}&to=${to}`),
        api.get(`/reports/trading?date=${to}`),
      ]);
      setTherapistData(t);
      setTrading(td);
    } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  function setRange(f, t2) { setFrom(f); setTo(t2); }

  function exportCsv() {
    if (!therapistData) return;
    const rows = [];
    // Shop identity header for the CSV
    const id = therapistData?.identity;
    if (id?.spa_name) rows.push([id.spa_name]);
    if (id?.spa_address) rows.push([id.spa_address]);
    if (id?.spa_phone || id?.spa_email) rows.push([[id.spa_phone, id.spa_email].filter(Boolean).join(' · ')]);
    rows.push([`Reports ${from} → ${to}`]);
    rows.push([]);
    rows.push(['Therapist breakdown']);
    rows.push(['Therapist', 'Bills', 'Hours worked', 'Requested hours', 'Requested %', 'Revenue £', 'Tips £', 'Total £']);
    (therapistData.therapists || []).forEach((t) => {
      const pct = t.minutes_worked > 0 ? Math.round((t.minutes_requested * 100) / t.minutes_worked) : 0;
      rows.push([
        t.name || '— (unassigned)',
        t.bills,
        fmtMins(t.minutes_worked),
        fmtMins(t.minutes_requested),
        pct + '%',
        Number(t.revenue).toFixed(2),
        Number(t.tips).toFixed(2),
        Number(t.total).toFixed(2),
      ]);
    });
    const pb = therapistData.payment_breakdown || { money_taken: therapistData.by_payment_method || [], already_paid: [] };
    rows.push([]);
    rows.push(['By payment method — money taken (= revenue)', 'Bills', 'Amount £']);
    pb.money_taken.forEach((m) => {
      const note = Number(m.voucher_portion) > 0 ? ` (incl. ${Number(m.voucher_portion).toFixed(2)} voucher sales)` : '';
      rows.push([(METHOD_STYLE[m.payment_method] || METHOD_STYLE.unknown).label.replace(/^\S+\s/, '') + note, m.n, Number(m.revenue).toFixed(2)]);
    });
    if (pb.already_paid && pb.already_paid.length) {
      rows.push([]);
      rows.push(['Covered by an earlier payment (NOT in revenue)', 'Bills', 'Amount £']);
      pb.already_paid.forEach((m) => {
        rows.push([(AP_LABEL[m.payment_method] || m.payment_method).replace(/^\S+\s/, ''), m.n, Number(m.amount).toFixed(2)]);
      });
    }
    downloadCsv(`reports_${from}_to_${to}.csv`, rows);
  }

  const total = therapistData?.by_payment_method?.reduce((s, m) => s + Number(m.revenue || 0), 0) || 0;

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Reports</h2>
          <div className="sub">Trading, therapist hours, payment-method breakdown — default today</div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button onClick={exportCsv} disabled={!therapistData}>📥 Export CSV</button>
          <button onClick={() => window.print()}>🖨 Print</button>
        </div>
      </div>

      {/* Spa identity header — printed/exported reports carry the
          business name. Pulled from settings.spa_name (+ address /
          phone / email) by the backend. */}
      {therapistData?.identity?.spa_name && (
        <div style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 700, color: '#1e3a6e', letterSpacing: '0.02em' }}>
            {therapistData.identity.spa_name}
          </div>
          {(therapistData.identity.spa_address || therapistData.identity.spa_phone) && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {[therapistData.identity.spa_address, therapistData.identity.spa_phone].filter(Boolean).join(' · ')}
            </div>
          )}
          {therapistData.identity.spa_email && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{therapistData.identity.spa_email}</div>
          )}
        </div>
      )}

      {/* Date range + quick presets */}
      <div className="card col" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => setRange(todayISO(), todayISO())}>Today</button>
            <button onClick={() => setRange(isoDaysAgo(1), isoDaysAgo(1))}>Yesterday</button>
            <button onClick={() => setRange(isoDaysAgo(6), todayISO())}>Last 7 days</button>
            <button onClick={() => setRange(startOfWeek(), todayISO())}>This week</button>
            <button onClick={() => setRange(startOfMonth(), todayISO())}>This month</button>
            <button onClick={() => setRange(isoDaysAgo(29), todayISO())}>Last 30 days</button>
          </div>
        </div>
      </div>

      {loading && <div className="muted">Loading…</div>}

      {/* Payment method breakdown for the range */}
      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Payment methods — {from === to ? from : `${from} → ${to}`}</h3>
          <span className="muted" style={{ fontSize: 12 }}>Money taken (incl. voucher sales) = revenue</span>
        </div>
        {!therapistData?.by_payment_method?.length ? (
          <div className="muted">No closed bills in this range.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {therapistData.by_payment_method.map((m) => {
              const meta = METHOD_STYLE[m.payment_method] || METHOD_STYLE.unknown;
              const pct = total > 0 ? Math.round((Number(m.revenue) * 100) / total) : 0;
              return (
                <div key={m.payment_method} style={{
                  background: 'white', border: '1px solid var(--border)',
                  borderTop: `3px solid ${meta.color}`,
                  borderRadius: 'var(--radius)', padding: '14px 16px',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: meta.color, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                    {meta.label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6, color: meta.color }}>
                    {fmtMoney(m.revenue)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {m.n} bills · {pct}%
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Covered by an earlier payment — voucher redemptions / external / deposits */}
      {therapistData?.payment_breakdown?.already_paid?.length > 0 && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>Covered by an earlier payment</h3>
            <span className="muted" style={{ fontSize: 12 }}>Not counted in revenue — already paid</span>
          </div>
          {therapistData.payment_breakdown.already_paid.map((m) => (
            <div key={m.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
              <span>{AP_LABEL[m.payment_method] || m.payment_method}</span>
              <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{m.n} · {fmtMoney(m.amount)}</span>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            This money came in earlier (voucher sold, paid online, or before SiamEPOS), so it isn't added to revenue again.
          </div>
        </div>
      )}

      {/* Booking source — Treatwell vs direct */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Booking source — {to}</h3>
          <span className="muted" style={{ fontSize: 12 }}>Where the To-date bookings came from</span>
        </div>
        {!trading?.by_source?.length ? (
          <div className="muted" style={{ marginTop: 10 }}>No bookings on this date.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginTop: 12 }}>
            {trading.by_source.map((row) => {
              const meta = SOURCE_LABEL[row.source] || SOURCE_LABEL.unknown;
              return (
                <div key={row.source} style={{
                  background: meta.bg, color: meta.color,
                  borderRadius: 10, padding: '14px 16px',
                  border: `1px solid ${meta.color}22`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                    {meta.label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>
                    {row.appointments} <span style={{ fontSize: 12, fontWeight: 500, opacity: 0.7 }}>bookings</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4, opacity: 0.85 }}>{fmtMoney(row.revenue)} revenue</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Therapist breakdown with hours + requested hours */}
      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Therapist performance</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            <strong>Requested</strong> = customer asked for this therapist specifically
          </span>
        </div>
        {!therapistData?.therapists?.length ? (
          <div className="muted">No data.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ padding: '8px 6px' }}>Therapist</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Bills</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Hours worked</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Requested hours</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>%</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Revenue</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Tips</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {therapistData.therapists.map((t) => {
                  const pct = t.minutes_worked > 0 ? Math.round((t.minutes_requested * 100) / t.minutes_worked) : 0;
                  return (
                    <tr key={t.id || 'none'} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 6px', fontWeight: 600 }}>{t.name || <span className="muted">— (unassigned)</span>}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right' }}>{t.bills}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 600 }}>{fmtMins(t.minutes_worked)}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', color: t.minutes_requested > 0 ? 'var(--gold)' : 'var(--muted)', fontWeight: t.minutes_requested > 0 ? 700 : 400 }}>
                        {fmtMins(t.minutes_requested)}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', color: 'var(--muted)' }}>
                        {t.minutes_worked > 0 ? pct + '%' : '—'}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{fmtMoney(t.revenue)}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontFamily: 'monospace', color: t.tips > 0 ? 'var(--success)' : 'var(--muted)' }}>{fmtMoney(t.tips)}</td>
                      <td style={{ padding: '10px 6px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{fmtMoney(t.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
