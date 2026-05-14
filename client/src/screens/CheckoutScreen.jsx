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
              <div className="row">
                <button onClick={() => pay('cash')} disabled={busy} style={{ flex: 1, padding: 14 }}>Cash</button>
                <button onClick={() => pay('card')} disabled={busy} className="primary" style={{ flex: 1, padding: 14 }}>Card</button>
                <button onClick={() => pay('split')} disabled={busy} style={{ flex: 1, padding: 14 }}>Split</button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Card payments go via Stripe. Set <code>STRIPE_PUBLISHABLE_KEY</code> and
                <code> STRIPE_SECRET_KEY</code> on the backend to enable.
              </div>
            </div>
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
