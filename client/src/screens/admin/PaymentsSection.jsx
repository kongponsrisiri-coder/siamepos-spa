// SEPOS-SPA-PAYLINK-001, Phase 1 — Payment Links.
// Staff generate a one-off Stripe payment link for an ad-hoc amount, then copy
// it or show the QR for the customer to pay remotely. Status (pending → paid)
// is reconciled by the webhook and refreshed from Stripe on load.

import React, { useEffect, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { api } from '../../api.js';

const STATUS_STYLE = {
  pending:   { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
  paid:      { bg: '#dcfce7', color: '#166534', label: 'Paid' },
  cancelled: { bg: '#f3f4f6', color: '#4b5563', label: 'Cancelled' },
  expired:   { bg: '#f3f4f6', color: '#4b5563', label: 'Expired' },
};

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.pending;
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>
      {s.label}
    </span>
  );
}

export default function PaymentsSection() {
  const [amount, setAmount]   = useState('');
  const [desc, setDesc]       = useState('');
  const [email, setEmail]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');
  const [created, setCreated] = useState(null); // the just-created link
  const [qr, setQr]           = useState('');   // data-URL for the created link
  const [list, setList]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [stripeOk, setStripeOk] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/payment-links');
      setList(r.links || []);
    } finally { setLoading(false); }
  }, []);

  const loadStripe = useCallback(async () => {
    try { const r = await api.get('/widget/stripe-config'); setStripeOk(!!r.configured); }
    catch { setStripeOk(null); }
  }, []);

  useEffect(() => { load(); loadStripe(); }, [load, loadStripe]);

  async function generate() {
    setError('');
    const amt = Number(amount);
    if (!amt || amt <= 0) { setError('Enter a valid amount'); return; }
    setBusy(true);
    try {
      const r = await api.post('/payment-links', { amount: amt, description: desc || null, customer_email: email || null });
      setCreated(r.link);
      const dataUrl = await QRCode.toDataURL(r.link.url, { width: 220, margin: 1 });
      setQr(dataUrl);
      setAmount(''); setDesc(''); setEmail('');
      load();
    } catch (e) {
      setError(e.message || 'Could not create link');
    } finally { setBusy(false); }
  }

  async function copy(url) {
    // window.prompt is disabled in Electron — fall back to alert with the URL.
    try { await navigator.clipboard.writeText(url); alert('Link copied to clipboard'); }
    catch { alert('Copy this link:\n\n' + url); }
  }

  async function cancelLink(id) {
    if (!confirm('Cancel this payment link? The customer will no longer be able to pay it.')) return;
    try { await api.post(`/payment-links/${id}/cancel`, {}); load(); }
    catch (e) { alert(e.message || 'Could not cancel'); }
  }

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Payments</h2>
          <div className="sub">Create a payment link to take a card payment remotely</div>
        </div>
      </div>

      {stripeOk === false && (
        <div className="card" style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠️ Stripe isn't connected</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            Payment links need Stripe. Add <code>STRIPE_PUBLISHABLE_KEY</code> and
            <code> STRIPE_SECRET_KEY</code> to your Railway environment variables, then redeploy.
          </div>
        </div>
      )}

      {/* ── Create ─────────────────────────────────────────────────── */}
      <div className="card col">
        <h3 style={{ margin: 0 }}>New payment link</h3>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 140 }}>
            <label>Amount (£)</label>
            <input type="number" step="0.5" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>Description <span className="muted" style={{ fontSize: 12 }}>(shown to the customer)</span></label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Booking deposit — Mrs Smith" />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>Customer email <span className="muted" style={{ fontSize: 12 }}>(optional — for the receipt)</span></label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" />
          </div>
        </div>
        {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}
        <div className="row">
          <button className="primary" disabled={busy || stripeOk === false} onClick={generate}>
            {busy ? 'Creating…' : 'Generate link'}
          </button>
        </div>

        {created && (
          <div className="row" style={{ gap: 18, alignItems: 'flex-start', borderTop: '1px solid var(--border)', paddingTop: 14, flexWrap: 'wrap' }}>
            {qr && <img src={qr} alt="Payment QR code" width={160} height={160} style={{ border: '1px solid var(--border)', borderRadius: 8 }} />}
            <div className="col" style={{ flex: 1, minWidth: 240, gap: 8 }}>
              <div style={{ fontWeight: 700 }}>{fmtMoney(created.amount)} — link ready</div>
              <div className="muted" style={{ fontSize: 13 }}>{created.description || 'SiamEPOS Spa payment'}</div>
              <input readOnly value={created.url} onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} />
              <div className="row">
                <button className="primary" onClick={() => copy(created.url)}>📋 Copy link</button>
                <a href={created.url} target="_blank" rel="noreferrer"><button>Open</button></a>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>This link expires in ~24 hours. Show the QR or copy the link to the customer.</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Recent links ───────────────────────────────────────────── */}
      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Recent links</h3>
          <button onClick={load} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
        {list.length === 0 ? (
          <div className="muted">No payment links yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 4px' }}>Created</th>
                <th style={{ padding: '6px 4px' }}>Amount</th>
                <th style={{ padding: '6px 4px' }}>Description</th>
                <th style={{ padding: '6px 4px' }}>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 4px' }} className="muted">{fmtDate(l.created_at)}</td>
                  <td style={{ padding: '6px 4px', fontWeight: 600 }}>{fmtMoney(l.amount)}</td>
                  <td style={{ padding: '6px 4px' }}>{l.description || '—'}</td>
                  <td style={{ padding: '6px 4px' }}><StatusBadge status={l.status} /></td>
                  <td style={{ padding: '6px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {l.status === 'pending' && l.url && <button onClick={() => copy(l.url)}>Copy</button>}{' '}
                    {l.status === 'pending' && <button onClick={() => cancelLink(l.id)}>Cancel</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
