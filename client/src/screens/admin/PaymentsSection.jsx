// SEPOS-SPA-PAYLINK-001 — Payment Links.
// Two ways to take a card payment remotely:
//   • Custom amount — ad-hoc one-off charge.
//   • Phone booking — pick a treatment + slot + customer, hold the booking, and
//     generate a deposit link (amount from the spa's deposit policy). When the
//     customer pays, the appointment is marked deposit_paid.

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
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Mirrors the backend deposit calc so we can preview what the customer pays.
function previewDeposit(policy, price) {
  const p = Number(price || 0);
  if (!policy) return null;
  if (policy.deposit_model === 'none')        return 0;
  if (policy.deposit_model === 'full_prepay') return p;
  if (policy.deposit_model === 'percentage')  return +((p * policy.deposit_percentage) / 100).toFixed(2);
  return Math.min(Number(policy.deposit_amount), p);
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
  const [mode, setMode] = useState('amount'); // 'amount' | 'booking'
  const [created, setCreated] = useState(null);
  const [qr, setQr]           = useState('');
  const [list, setList]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [stripeOk, setStripeOk] = useState(null);
  const [policy, setPolicy]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api.get('/payment-links'); setList(r.links || []); }
    finally { setLoading(false); }
  }, []);

  const loadStripe = useCallback(async () => {
    try { const r = await api.get('/widget/stripe-config'); setStripeOk(!!r.configured); setPolicy(r.policy || null); }
    catch { setStripeOk(null); }
  }, []);

  useEffect(() => { load(); loadStripe(); }, [load, loadStripe]);

  async function showCreated(link) {
    setCreated(link);
    try { setQr(await QRCode.toDataURL(link.url, { width: 220, margin: 1 })); }
    catch { setQr(''); }
    load();
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
          <div className="sub">Take a card payment remotely — a custom amount or a phone booking deposit</div>
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

      {/* Mode toggle */}
      <div className="row" style={{ gap: 6 }}>
        {[['amount', '£ Custom amount'], ['booking', '📅 Phone booking']].map(([k, label]) => {
          const active = mode === k;
          return (
            <button key={k} onClick={() => setMode(k)} style={{
              padding: '8px 14px',
              background: active ? '#1e3a6e' : 'white',
              color: active ? 'white' : '#1e3a6e',
              border: `1px solid ${active ? '#1e3a6e' : 'var(--border)'}`,
              fontWeight: active ? 700 : 500,
            }}>{label}</button>
          );
        })}
      </div>

      {mode === 'amount'
        ? <AmountForm stripeOk={stripeOk} onCreated={showCreated} />
        : <BookingForm stripeOk={stripeOk} policy={policy} onCreated={showCreated} />}

      {created && (
        <div className="card col">
          <div className="row" style={{ gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {qr && <img src={qr} alt="Payment QR code" width={160} height={160} style={{ border: '1px solid var(--border)', borderRadius: 8 }} />}
            <div className="col" style={{ flex: 1, minWidth: 240, gap: 8 }}>
              <div style={{ fontWeight: 700 }}>{fmtMoney(created.amount)} — link ready</div>
              <div className="muted" style={{ fontSize: 13 }}>{created.description || 'SiamEPOS Spa payment'}</div>
              <input readOnly value={created.url} onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} />
              <div className="row">
                <button className="primary" onClick={() => copy(created.url)}>📋 Copy link</button>
                <a href={created.url} target="_blank" rel="noreferrer"><button>Open</button></a>
                <button onClick={() => { setCreated(null); setQr(''); }}>Done</button>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>Expires in ~24 hours. Show the QR or copy the link to the customer.</div>
            </div>
          </div>
        </div>
      )}

      {/* Recent links */}
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
                  <td style={{ padding: '6px 4px' }}>
                    {l.purpose === 'deposit' && <span style={{ marginRight: 6 }}>📅</span>}
                    {l.description || '—'}
                  </td>
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

// ── Custom amount ─────────────────────────────────────────────────────
function AmountForm({ stripeOk, onCreated }) {
  const [amount, setAmount] = useState('');
  const [desc, setDesc]     = useState('');
  const [email, setEmail]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');

  async function generate() {
    setError('');
    const amt = Number(amount);
    if (!amt || amt <= 0) { setError('Enter a valid amount'); return; }
    setBusy(true);
    try {
      const r = await api.post('/payment-links', { amount: amt, description: desc || null, customer_email: email || null });
      setAmount(''); setDesc(''); setEmail('');
      onCreated(r.link);
    } catch (e) { setError(e.message || 'Could not create link'); }
    finally { setBusy(false); }
  }

  return (
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
          <label>Customer email <span className="muted" style={{ fontSize: 12 }}>(optional)</span></label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" />
        </div>
      </div>
      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      <div className="row">
        <button className="primary" disabled={busy || stripeOk === false} onClick={generate}>
          {busy ? 'Creating…' : 'Generate link'}
        </button>
      </div>
    </div>
  );
}

// ── Phone booking ─────────────────────────────────────────────────────
function BookingForm({ stripeOk, policy, onCreated }) {
  const [treatments, setTreatments] = useState([]);
  const [treatmentId, setTreatmentId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [slots, setSlots] = useState(null);     // null = not searched yet
  const [slotsBusy, setSlotsBusy] = useState(false);
  const [slot, setSlot] = useState(null);        // selected slot object
  const [therapistId, setTherapistId] = useState('');
  const [name, setName]   = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [gdpr, setGdpr]   = useState(false);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/treatments').then((r) => setTreatments(r.treatments || [])).catch(() => {});
  }, []);

  const treatment = treatments.find((t) => String(t.id) === String(treatmentId));
  const deposit = treatment ? previewDeposit(policy, treatment.price) : null;

  async function findSlots() {
    setError(''); setSlot(null); setTherapistId('');
    if (!treatmentId) { setError('Pick a treatment first'); return; }
    setSlotsBusy(true);
    try {
      const r = await api.get(`/appointments/availability?treatment_id=${treatmentId}&date=${date}`);
      setSlots(r.slots || []);
    } catch (e) { setError(e.message || 'Could not load availability'); }
    finally { setSlotsBusy(false); }
  }

  async function createBookingAndLink() {
    setError('');
    if (!treatmentId)  { setError('Pick a treatment'); return; }
    if (!slot)         { setError('Pick a time'); return; }
    if (!name.trim())  { setError('Customer name is required'); return; }
    if (!gdpr)         { setError('Please confirm the customer consents to storing their details (GDPR)'); return; }
    setBusy(true);
    try {
      // 1. Create the client record.
      const cr = await api.post('/clients', {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        gdpr_consent: true,
        marketing_consent: false,
      });
      // 2. Create the appointment (hold the slot).
      const ar = await api.post('/appointments?allow_past=1', {
        client_id: cr.client.id,
        treatment_id: Number(treatmentId),
        therapist_id: therapistId ? Number(therapistId) : null,
        room_id: null,
        starts_at: slot.starts_at,
        source: 'phone',
        therapist_requested: !!therapistId,
      });
      // 3. Generate the deposit link for that booking.
      const lr = await api.post('/payment-links', { appointment_id: ar.appointment.id, customer_email: email.trim() || null });
      // reset
      setName(''); setPhone(''); setEmail(''); setGdpr(false); setSlot(null); setSlots(null); setTherapistId('');
      onCreated(lr.link);
    } catch (e) {
      if (e.data && e.data.error === 'conflict') setError('That slot was just taken — pick another time.');
      else setError(e.message || 'Could not create the booking');
    } finally { setBusy(false); }
  }

  return (
    <div className="card col">
      <h3 style={{ margin: 0 }}>Phone booking + deposit link</h3>
      <p className="muted" style={{ margin: 0 }}>
        Pick the treatment and time, add the customer, and we'll hold the booking and create a link
        for them to pay. The amount comes from your{' '}
        <strong>{policy ? (policy.deposit_model === 'full_prepay' ? 'full prepay' : policy.deposit_model.replace('_', ' ')) : 'deposit'}</strong> policy.
      </p>

      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label>Treatment</label>
          <select value={treatmentId} onChange={(e) => { setTreatmentId(e.target.value); setSlots(null); setSlot(null); }}>
            <option value="">Choose…</option>
            {treatments.map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {fmtMoney(t.price)} ({t.duration_minutes}m)</option>
            ))}
          </select>
        </div>
        <div style={{ width: 170 }}>
          <label>Date</label>
          <input type="date" value={date} min={todayStr()} onChange={(e) => { setDate(e.target.value); setSlots(null); setSlot(null); }} />
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button onClick={findSlots} disabled={slotsBusy || !treatmentId}>{slotsBusy ? 'Finding…' : 'Find times'}</button>
        </div>
      </div>

      {treatment && deposit != null && (
        <div className="muted" style={{ fontSize: 13 }}>
          Customer will pay <strong>{fmtMoney(deposit)}</strong>{policy && policy.deposit_model === 'full_prepay' ? ' (full payment)' : ' (deposit)'}.
        </div>
      )}

      {slots && (
        slots.length === 0
          ? <div className="muted">No available times that day. Try another date.</div>
          : (
            <div>
              <label>Time</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {slots.map((sl) => {
                  const active = slot && slot.starts_at === sl.starts_at;
                  return (
                    <button key={sl.starts_at}
                      onClick={() => { setSlot(sl); setTherapistId(''); }}
                      style={{
                        padding: '6px 12px',
                        background: active ? '#1e3a6e' : 'white',
                        color: active ? 'white' : '#1e3a6e',
                        border: `1px solid ${active ? '#1e3a6e' : 'var(--border)'}`,
                        fontWeight: active ? 700 : 500,
                      }}>{fmtTime(sl.starts_at)}</button>
                  );
                })}
              </div>
            </div>
          )
      )}

      {slot && (
        <div style={{ maxWidth: 280 }}>
          <label>Therapist</label>
          <select value={therapistId} onChange={(e) => setTherapistId(e.target.value)}>
            <option value="">Any available</option>
            {(slot.therapists || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}

      {slot && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label>Customer name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            <label>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label>Email <span className="muted" style={{ fontSize: 12 }}>(for the receipt)</span></label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" />
          </div>
        </div>
      )}

      {slot && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={gdpr} onChange={(e) => setGdpr(e.target.checked)} />
          <span>Customer consents to storing their details (GDPR)</span>
        </label>
      )}

      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}

      {slot && (
        <div className="row">
          <button className="primary" disabled={busy || stripeOk === false} onClick={createBookingAndLink}>
            {busy ? 'Booking…' : 'Hold booking & create link'}
          </button>
        </div>
      )}
    </div>
  );
}
