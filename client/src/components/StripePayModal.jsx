import React, { useEffect, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { api } from '../api.js';

// One-shot loader cache — Stripe insists on a single loadStripe() per page.
let stripePromise = null;
function getStripe(pk) {
  if (!stripePromise && pk) stripePromise = loadStripe(pk);
  return stripePromise;
}

export default function StripePayModal({ bill, onClose, onPaid }) {
  const [config, setConfig]       = useState(null);
  const [clientSecret, setSecret] = useState(null);
  const [error, setError]         = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get('/stripe/config'),
      api.post('/stripe/create-intent', { bill_id: bill.id }),
    ])
      .then(([cfg, intent]) => {
        if (!alive) return;
        if (!cfg.configured) {
          setError('Stripe is not configured on the server. Add STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY.');
          return;
        }
        setConfig(cfg);
        setSecret(intent.client_secret);
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [bill.id]);

  const stripe = config?.publishable_key ? getStripe(config.publishable_key) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Card payment</h3>
        <div className="muted" style={{ marginBottom: 12 }}>
          £{Number(bill.total).toFixed(2)} · Bill #{bill.id}
        </div>

        {error && <div style={{ color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}

        {!error && (!stripe || !clientSecret) && <div className="muted">Loading Stripe…</div>}

        {!error && stripe && clientSecret && (
          <Elements stripe={stripe} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
            <PayForm bill={bill} onPaid={onPaid} onClose={onClose} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function PayForm({ bill, onPaid, onClose }) {
  const stripe   = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true); setError('');
    const { error: err, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });
    if (err) {
      setError(err.message || 'Payment failed');
      setBusy(false);
      return;
    }
    if (paymentIntent?.status === 'succeeded') {
      // The webhook will flip the bill to paid; we optimistically update too
      // so the UI moves on even if the webhook is delayed.
      try { await api.post(`/bills/${bill.id}/pay`, { method: 'card' }); } catch {}
      onPaid();
    } else {
      setError(`Payment status: ${paymentIntent?.status || 'unknown'}`);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="col">
      <PaymentElement />
      {error && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={!stripe || busy}>
          {busy ? 'Processing…' : 'Pay now'}
        </button>
      </div>
    </form>
  );
}
