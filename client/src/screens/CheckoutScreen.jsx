import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StripePayModal from '../components/StripePayModal.jsx';

function fmtMoney(n) { return `£${Number(n || 0).toFixed(2)}`; }

export default function CheckoutScreen() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();

  const [appt, setAppt]         = useState(null);
  const [bill, setBill]         = useState(null);
  const [tip, setTip]           = useState(0);
  const [tipSuggestions, setTipSuggestions] = useState([10, 12.5, 15]);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [showStripe, setShowStripe] = useState(false);
  const [voucherCode, setVoucherCode] = useState('');
  const [voucherLookup, setVoucherLookup] = useState(null);   // { voucher } or null
  const [voucherError, setVoucherError]   = useState('');
  const [showVoucher, setShowVoucher]     = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await api.get(`/appointments?date=${new Date().toISOString().slice(0, 10)}`);
      // Look up by appointment_id across a wider window if not found today.
      let a = list.appointments.find((x) => x.id === Number(appointmentId));
      if (!a) {
        const wide = await api.get(`/appointments?from=2000-01-01&to=2100-01-01&`);
        a = wide.appointments.find((x) => x.id === Number(appointmentId));
      }
      setAppt(a);

      // Make sure the bill exists (idempotent).
      const r = await api.post('/bills', { appointment_id: Number(appointmentId) });
      setBill(r.bill);
      setTip(Number(r.bill.tip || 0));

      const s = await api.get('/settings');
      if (s.settings.tip_suggestions) {
        setTipSuggestions(
          s.settings.tip_suggestions.split(',').map((x) => Number(x)).filter((x) => !Number.isNaN(x)),
        );
      }
    } catch (e) { setError(e.message); }
  }, [appointmentId]);

  useEffect(() => { load(); }, [load]);

  async function saveTip(value) {
    setTip(value);
    try {
      const r = await api.put(`/bills/${bill.id}/tip`, { tip: value });
      setBill(r.bill);
    } catch (e) { setError(e.message); }
  }

  async function pay(method) {
    if (method === 'card') { setShowStripe(true); return; }
    setBusy(true); setError('');
    try {
      await api.post(`/bills/${bill.id}/pay`, { method });
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function lookupVoucher() {
    if (!voucherCode.trim()) return;
    setVoucherError('');
    try {
      const r = await api.get(`/vouchers/lookup?code=${encodeURIComponent(voucherCode.trim().toUpperCase())}`);
      if (r.voucher.status !== 'active') {
        setVoucherError(`Voucher is ${r.voucher.status}`);
        setVoucherLookup(null);
      } else {
        setVoucherLookup(r);
        setVoucherError('');
      }
    } catch (e) {
      setVoucherError(e.message || 'Voucher not found');
      setVoucherLookup(null);
    }
  }

  async function payWithVoucher() {
    if (!voucherLookup) return;
    const v = voucherLookup.voucher;
    const amountToUse = Math.min(Number(v.remaining_value), total);
    setBusy(true); setError('');
    try {
      // Redeem against the voucher
      await api.post(`/vouchers/${v.id}/redeem`, {
        amount: amountToUse,
        bill_id: bill.id,
        notes: `Checkout for appointment #${appointmentId}`,
      });
      // Mark the bill as paid by voucher
      await api.post(`/bills/${bill.id}/pay`, { method: 'voucher' });
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message || 'Voucher redemption failed');
      setBusy(false);
    }
  }

  if (error && !appt) return <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>;
  if (!appt || !bill) return <div className="muted">Loading…</div>;

  const subtotal = Number(bill.subtotal || 0);
  const total = subtotal + Number(tip || 0);
  const paid = bill.payment_status === 'paid';

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }} className="col">
      <button onClick={() => navigate('/')} style={{ alignSelf: 'flex-start' }}>← Back</button>

      <div className="card col">
        <h2 style={{ margin: 0 }}>Checkout</h2>
        <div className="muted">
          {appt.client_name || 'Walk-in'} · {appt.treatment_name} ·{' '}
          {new Date(appt.starts_at).toLocaleString('en-GB')}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>Treatment</span><span>{fmtMoney(subtotal)}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <span>Tip</span><span>{fmtMoney(tip)}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, fontWeight: 700, fontSize: 18 }}>
            <span>Total</span><span>{fmtMoney(total)}</span>
          </div>
        </div>

        {!paid && (
          <>
            <div>
              <label>Tip</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {tipSuggestions.map((p) => {
                  const amount = +(subtotal * p / 100).toFixed(2);
                  return (
                    <button key={p} onClick={() => saveTip(amount)}>
                      {p}% ({fmtMoney(amount)})
                    </button>
                  );
                })}
                <button onClick={() => saveTip(0)}>No tip</button>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  placeholder="Custom"
                  value={tip || ''}
                  onChange={(e) => saveTip(Number(e.target.value) || 0)}
                  style={{ width: 100 }}
                />
              </div>
            </div>

            <div>
              <label>Payment method</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button onClick={() => pay('cash')} disabled={busy} style={{ flex: 1, padding: 14, minWidth: 80 }}>Cash</button>
                <button onClick={() => pay('card')} disabled={busy} className="primary" style={{ flex: 1, padding: 14, minWidth: 80 }}>Card</button>
                <button onClick={() => pay('split')} disabled={busy} style={{ flex: 1, padding: 14, minWidth: 80 }}>Split</button>
                <button onClick={() => setShowVoucher(v => !v)} disabled={busy} style={{ flex: 1, padding: 14, minWidth: 80, background: showVoucher ? '#C9A84C' : undefined, color: showVoucher ? '#1e3a6e' : undefined, fontWeight: showVoucher ? 700 : undefined }}>🎁 Voucher</button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Card payments go via Stripe. Set <code>STRIPE_PUBLISHABLE_KEY</code> and
                <code> STRIPE_SECRET_KEY</code> on the backend to enable.
              </div>
            </div>

            {/* Voucher redemption panel */}
            {showVoucher && (
              <div style={{ background: '#fffbeb', border: '1px solid #C9A84C', borderRadius: 10, padding: 14 }} className="col">
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: '#1e3a6e' }}>🎁 Redeem Gift Voucher</div>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    placeholder="Voucher code e.g. SPA-A1B2C3D4"
                    value={voucherCode}
                    onChange={e => { setVoucherCode(e.target.value.toUpperCase()); setVoucherLookup(null); setVoucherError(''); }}
                    style={{ flex: 1, fontFamily: 'monospace', letterSpacing: 1 }}
                    onKeyDown={e => e.key === 'Enter' && lookupVoucher()}
                  />
                  <button onClick={lookupVoucher} disabled={!voucherCode.trim()}>Check</button>
                </div>
                {voucherError && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 6 }}>{voucherError}</div>}
                {voucherLookup && (
                  <div style={{ marginTop: 10 }} className="col">
                    <div style={{ background: '#1e3a6e', color: 'white', borderRadius: 8, padding: '12px 16px' }}>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#C9A84C', letterSpacing: 1 }}>{voucherLookup.voucher.code}</div>
                          {voucherLookup.voucher.purchased_for && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>For {voucherLookup.voucher.purchased_for}</div>}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: '#C9A84C' }}>£{Number(voucherLookup.voucher.remaining_value).toFixed(2)}</div>
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>available</div>
                        </div>
                      </div>
                    </div>
                    {Number(voucherLookup.voucher.remaining_value) < total && (
                      <div style={{ fontSize: 13, color: '#b45309', background: '#fef3c7', padding: '8px 12px', borderRadius: 8, marginTop: 8 }}>
                        ⚠️ Voucher covers £{Number(voucherLookup.voucher.remaining_value).toFixed(2)} of £{total.toFixed(2)} — remainder will be waived in this transaction.
                      </div>
                    )}
                    <button className="primary" onClick={payWithVoucher} disabled={busy} style={{ width: '100%', padding: 14, marginTop: 8, background: '#C9A84C', color: '#1e3a6e', fontWeight: 700 }}>
                      {busy ? 'Processing…' : `Redeem £${Math.min(Number(voucherLookup.voucher.remaining_value), total).toFixed(2)} & Close Bill`}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {paid && (
          <div className="card" style={{ background: '#dcfce7', borderColor: '#86efac', textAlign: 'center' }}>
            <strong style={{ color: 'var(--success)' }}>Paid</strong>
            <div className="muted">{bill.payment_method} · {new Date(bill.closed_at).toLocaleString('en-GB')}</div>
          </div>
        )}

        {error && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>}
      </div>

      {showStripe && (
        <StripePayModal
          bill={bill}
          onClose={() => setShowStripe(false)}
          onPaid={() => { setShowStripe(false); navigate('/', { replace: true }); }}
        />
      )}
    </div>
  );
}
