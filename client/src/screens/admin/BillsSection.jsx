// Admin → Bills — paid bill history with delete (admin/manager only)
// Delete is hidden behind a 5-tap gesture on the heading + manager PIN.
// Deleting a bill resets the linked appointment back to 'booked'.

import { useState, useEffect } from 'react';
import { api, loginPin } from '../../api.js';

// Local-time YYYY-MM-DD — toISOString returns UTC, which rolls over to
// "tomorrow" between 23:00 and 00:00 local for any TZ ahead of UTC.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const METHOD_LABEL = { cash: '💵 Cash', card: '💳 Card', split: '🔀 Split', voucher: '🎁 Voucher', treatwell: '🌐 Treatwell' };
const UNLOCK_MS = 5 * 60 * 1000; // 5 minutes

export default function BillsSection() {
  const [from, setFrom]       = useState(todayISO());
  const [to,   setTo]         = useState(todayISO());
  const [bills, setBills]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [confirm, setConfirm]   = useState(null);
  const [receipt, setReceipt]   = useState(null); // bill row for the receipt modal

  // ── Hidden 5-tap unlock ──────────────────────────────────────────────────
  // Tap the "🧾 Bill Records" heading 5 times within 3 s to open the
  // manager PIN prompt. No visible lock icon — invisible to clients and
  // junior staff peeking at the screen.
  const [tapCount, setTapCount]           = useState(0);
  const [showUnlock, setShowUnlock]       = useState(false);
  const [unlockedUntil, setUnlockedUntil] = useState(null);
  const [tick, setTick]                   = useState(0);

  const isUnlocked  = unlockedUntil != null && unlockedUntil > Date.now();
  const secondsLeft = isUnlocked ? Math.max(0, Math.floor((unlockedUntil - Date.now()) / 1000)) : 0;
  const fmtCountdown = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // Tick every second while unlocked so the countdown updates
  useEffect(() => {
    if (!unlockedUntil) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [unlockedUntil]);
  useEffect(() => {
    if (unlockedUntil && Date.now() > unlockedUntil) setUnlockedUntil(null);
  }, [tick, unlockedUntil]);
  // Auto-lock when tab is left
  useEffect(() => () => setUnlockedUntil(null), []);
  // Reset tap counter 3 s after last tap
  useEffect(() => {
    if (tapCount === 0) return;
    const id = setTimeout(() => setTapCount(0), 3000);
    return () => clearTimeout(id);
  }, [tapCount]);

  const handleHeadingTap = () => {
    if (isUnlocked) return;
    const next = tapCount + 1;
    if (next >= 5) { setTapCount(0); setShowUnlock(true); }
    else setTapCount(next);
  };
  // ─────────────────────────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/bills?from=${from}&to=${to}`);
      setBills(r.bills || []);
    } catch (e) { alert('Failed to load bills: ' + e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line

  const handleDelete = async (bill) => {
    setDeleting(bill.id);
    try {
      await api.del(`/bills/${bill.id}`);
      setConfirm(null);
      setBills(prev => prev.filter(b => b.id !== bill.id));
    } catch (e) { alert('Delete failed: ' + e.message); }
    finally { setDeleting(null); }
  };

  const total    = bills.reduce((s, b) => s + Number(b.total || 0), 0);
  const tipTotal = bills.reduce((s, b) => s + Number(b.tip   || 0), 0);
  // Money actually taken at the till — mirrors the revenue report: only the
  // cash/card/Treatwell portions count. Voucher redemptions, 'external' (already
  // paid), and online deposits are excluded (that money came in earlier).
  const TILL_METHODS = new Set(['cash', 'card', 'treatwell']);
  const billTaken = (b) => {
    if (b.payment_status === 'refunded') return 0;
    let sp = b.split_payments;
    if (typeof sp === 'string') { try { sp = JSON.parse(sp); } catch { sp = null; } }
    if (b.payment_method === 'split' && Array.isArray(sp)) {
      return sp.filter((p) => TILL_METHODS.has(p.method)).reduce((s, p) => s + Number(p.amount || 0), 0);
    }
    return TILL_METHODS.has(b.payment_method) ? Number(b.total || 0) : 0;
  };
  const takenTotal = bills.reduce((s, b) => s + billTaken(b), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Heading — 5 taps opens unlock prompt */}
      <div className="section-header">
        <div>
          <h2
            onClick={handleHeadingTap}
            style={{ margin: 0, cursor: 'default', userSelect: 'none' }}
          >Bills</h2>
          <div className="sub">Paid bill history · tap heading 5× to unlock manager delete</div>
        </div>

        {/* Countdown pill — only visible when unlocked */}
        {isUnlocked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#dcfce7', border: '1px solid #22c55e', borderRadius: 999, padding: '5px 14px' }}>
            <span style={{ fontSize: 13 }}>🔓</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#166534' }}>
              Manager mode · {fmtCountdown(secondsLeft)}
            </span>
            <button
              onClick={() => setUnlockedUntil(null)}
              style={{ background: 'transparent', border: 'none', color: '#166534', cursor: 'pointer', fontWeight: 800, fontSize: 11, padding: 0 }}
            >Lock</button>
          </div>
        )}
      </div>

      {/* Date filter */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 130px', minWidth: 120 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 3 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ flex: '1 1 130px', minWidth: 120 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 3 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ width: '100%' }} />
        </div>
        <button className="primary" onClick={load} disabled={loading} style={{ marginTop: 18 }}>
          {loading ? 'Loading…' : 'Search'}
        </button>
        <button onClick={() => { const t = todayISO(); setFrom(t); setTo(t); }} style={{ marginTop: 18, fontSize: 13 }}>Today</button>
      </div>

      {/* Summary row */}
      {bills.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'Bills',   value: bills.length },
            { label: 'Revenue', value: fmtMoney(total) },
            { label: 'Tips',    value: fmtMoney(tipTotal) },
            { label: 'Period',  value: `${fmtDate(from)} – ${fmtDate(to)}` },
          ].map(s => (
            <div key={s.label} className="card" style={{ flex: 1, minWidth: 120, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && bills.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <p className="muted">No paid bills found for this period.</p>
        </div>
      )}

      {/* Bill table */}
      {bills.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)', background: '#fafaf9' }}>
                {['Date / Time','Client','Treatment','Subtotal','Tip','Total','Method','Receipt', ...(isUnlocked ? [''] : [])].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bills.map(b => (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap', fontSize: 13 }}>{fmtDateTime(b.closed_at)}</td>
                  <td style={{ padding: '10px', fontWeight: 500 }}>{b.client_name || <span className="muted">Walk-in</span>}</td>
                  <td style={{ padding: '10px', color: 'var(--muted)', fontSize: 13 }}>{b.treatment_name || '—'}</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace' }}>{fmtMoney(b.subtotal)}</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace', color: b.tip > 0 ? 'var(--success)' : 'var(--muted)' }}>{fmtMoney(b.tip)}</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace', fontWeight: 700 }}>{fmtMoney(b.total)}</td>
                  <td style={{ padding: '10px', fontSize: 13 }}>
                    {METHOD_LABEL[b.payment_method] || b.payment_method || '—'}
                    {/* SPA-PAY-001 — break the split into its underlying
                        rows so an auditor can see exactly how the bill
                        was paid (deposit + cash, voucher + card, etc.) */}
                    {b.payment_method === 'split' && Array.isArray(b.split_payments) && b.split_payments.length > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>
                        {b.split_payments.map((p, i) => (
                          <div key={i}>
                            {p.method === 'deposit' ? '🌐' : p.method === 'voucher' ? '🎁' : p.method === 'cash' ? '💵' : p.method === 'card' ? '💳' : '·'}
                            {' '}
                            {p.method} £{Number(p.amount).toFixed(2)}
                          </div>
                        ))}
                      </div>
                    )}
                    {b.external_voucher_code && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                        🧾 ref: <strong style={{ color: 'var(--text)' }}>{b.external_voucher_code}</strong>
                      </div>
                    )}
                  </td>
                  {/* SEPOS-SPA-RECEIPT-001 — issue a (VAT) receipt, printable + emailable */}
                  <td style={{ padding: '10px' }}>
                    <button onClick={() => setReceipt(b)} style={{ fontSize: 12, padding: '4px 10px' }}>🧾 Receipt</button>
                  </td>
                  {/* 🗑 only visible when manager has unlocked */}
                  {isUnlocked && (
                    <td style={{ padding: '10px' }}>
                      <button
                        onClick={() => setConfirm(b)}
                        style={{ fontSize: 12, padding: '4px 10px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                      >🗑</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', background: '#fafaf9' }}>
                <td colSpan={3} style={{ padding: '8px 10px', fontWeight: 700, fontSize: 13 }}>Gross ({bills.length} bills)</td>
                <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 600 }}>{fmtMoney(total - tipTotal)}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--success)' }}>{fmtMoney(tipTotal)}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, fontSize: 15 }}>{fmtMoney(total)}</td>
                <td colSpan={isUnlocked ? 2 : 1} />
              </tr>
              {/* Money actually taken at the till — excludes voucher / already-paid
                  / online-deposit portions (they came in earlier). Matches the
                  Trading/Z revenue. Shown when it differs from the gross total. */}
              {Math.abs(takenTotal - total) > 0.005 && (
                <tr style={{ background: '#f0fdf4' }}>
                  <td colSpan={3} style={{ padding: '8px 10px', fontWeight: 700, fontSize: 13, color: '#166534' }}>
                    Taken at till <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(excl. vouchers / already-paid)</span>
                  </td>
                  <td /><td />
                  <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, fontSize: 15, color: '#166534' }}>{fmtMoney(takenTotal)}</td>
                  <td colSpan={isUnlocked ? 2 : 1} />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirm && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setConfirm(null)}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <h3 style={{ margin: '0 0 8px', color: 'var(--danger)' }}>🗑 Delete Bill?</h3>
            <p style={{ margin: '0 0 6px' }}>
              <strong>{confirm.client_name || 'Walk-in'}</strong> — {confirm.treatment_name}
            </p>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--muted)' }}>
              {fmtMoney(confirm.total)} · {fmtDateTime(confirm.closed_at)}
            </p>
            <p style={{ margin: '0 0 20px', fontSize: 13, background: '#fef3c7', padding: '8px 12px', borderRadius: 6 }}>
              ⚠️ This also resets the linked appointment back to <strong>Booked</strong> so it can be re-processed.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="danger" onClick={() => handleDelete(confirm)} disabled={!!deleting} style={{ flex: 1 }}>
                {deleting === confirm.id ? 'Deleting…' : 'Yes, Delete Bill'}
              </button>
              <button onClick={() => setConfirm(null)} disabled={!!deleting}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Manager PIN unlock modal */}
      {showUnlock && (
        <UnlockModal
          onClose={() => setShowUnlock(false)}
          onUnlocked={() => { setUnlockedUntil(Date.now() + UNLOCK_MS); setShowUnlock(false); }}
        />
      )}

      {/* SEPOS-SPA-RECEIPT-001 — receipt preview / print / email */}
      {receipt && <ReceiptModal bill={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

// ── Receipt modal — preview + print + email a (VAT) receipt ──────────────────
function ReceiptModal({ bill, onClose }) {
  const [html, setHtml]   = useState('');
  const [to, setTo]       = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.get(`/bills/${bill.id}/receipt`);
        if (!alive) return;
        setHtml(r.html || '');
        setTo(r.client_email || '');
      } catch (e) {
        if (alive) setMsg(e.message || 'Could not load the receipt.');
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [bill.id]);

  function printReceipt() {
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) { setMsg('Pop-up blocked — allow pop-ups to print.'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch {} }, 350);
  }

  async function emailReceipt() {
    if (!to.includes('@')) { setMsg('Enter a valid email address.'); return; }
    setBusy(true); setMsg('');
    try {
      await api.post(`/bills/${bill.id}/receipt-email`, { to: to.trim() });
      setMsg('✓ Receipt emailed to ' + to.trim());
    } catch (e) {
      setMsg(e.message || 'Could not send the receipt.');
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>🧾 Receipt · #{bill.id}</h3>
          <button onClick={onClose} style={{ fontSize: 13 }}>Close</button>
        </div>
        {loading ? (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>Loading…</div>
        ) : (
          <>
            <iframe title="receipt" srcDoc={html} style={{ width: '100%', height: 340, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <input value={to} onChange={e => { setTo(e.target.value); setMsg(''); }} placeholder="client@email.com" style={{ flex: 1 }} />
              <button onClick={emailReceipt} disabled={busy || !to} className="primary">{busy ? 'Sending…' : '✉️ Email'}</button>
              <button onClick={printReceipt}>🖨 Print</button>
            </div>
            {msg && <div style={{ marginTop: 10, fontSize: 13, color: msg.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>{msg}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ── Manager PIN unlock modal ─────────────────────────────────────────────────
// Only admin / manager roles can unlock.
function UnlockModal({ onClose, onUnlocked }) {
  const [pin, setPin]   = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const submit = async () => {
    if (!pin.trim()) { setErr('PIN required.'); return; }
    setBusy(true); setErr('');
    try {
      const staff = await loginPin(pin.trim());
      if (!staff) { setErr('Invalid PIN.'); setBusy(false); return; }
      const role = (staff.role || '').toLowerCase();
      if (!['admin', 'manager'].includes(role)) {
        setErr('That PIN doesn\'t have permission to delete bills.');
        setBusy(false); return;
      }
      onUnlocked();
    } catch (e) {
      setErr(e.message || 'PIN check failed.');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 360 }}>
        <div style={{ fontSize: 28, marginBottom: 6 }}>🔒</div>
        <h3 style={{ margin: '0 0 6px' }}>Unlock manager actions</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)' }}>
          Enter an admin or manager PIN to reveal delete buttons for the next 5 minutes.
        </p>
        <input
          type="password"
          autoFocus
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Manager PIN"
          maxLength={6}
          style={{ width: '100%', padding: '12px', fontSize: 20, textAlign: 'center', letterSpacing: 8, fontFamily: 'monospace', borderRadius: 8, border: '1px solid var(--border)', boxSizing: 'border-box' }}
        />
        {err && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--danger)', background: '#fee2e2', padding: '8px 12px', borderRadius: 6 }}>{err}</p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="primary" onClick={submit} disabled={busy} style={{ flex: 1 }}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
          <button onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
