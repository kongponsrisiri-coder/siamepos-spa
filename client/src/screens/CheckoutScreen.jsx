import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

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
  const [voucherCode, setVoucherCode] = useState('');
  const [voucherLookup, setVoucherLookup] = useState(null);   // { voucher } or null
  const [voucherError, setVoucherError]   = useState('');
  const [showVoucher, setShowVoucher]     = useState(false);
  const [showSplit, setShowSplit]         = useState(false);
  const [showDiscount, setShowDiscount]   = useState(false);
  const [discountReason, setDiscountReason] = useState('');
  const [showLegacy, setShowLegacy]       = useState(false);
  const [legacyAmount, setLegacyAmount]   = useState('');
  const [showTreatwell, setShowTreatwell] = useState(false);
  const [treatwellAmount, setTreatwellAmount] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      // Local-time date so the query matches what the operator sees
      // on the timeline (toISOString returns UTC).
      const td = new Date();
      const todayStr = `${td.getFullYear()}-${String(td.getMonth()+1).padStart(2,'0')}-${String(td.getDate()).padStart(2,'0')}`;
      const list = await api.get(`/appointments?date=${todayStr}`);
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

  async function saveDiscount(amount, reason) {
    try {
      const r = await api.put(`/bills/${bill.id}/discount`, { discount: amount, reason });
      setBill(r.bill);
      setDiscountReason(reason || '');
    } catch (e) { setError(e.message); }
  }

  async function pay(method, extras = {}) {
    setBusy(true); setError('');
    try {
      await api.post(`/bills/${bill.id}/pay`, { method, ...extras });
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

  async function payWithVoucher(customAmount) {
    if (!voucherLookup) return;
    const v = voucherLookup.voucher;
    setBusy(true); setError('');
    try {
      if (v.voucher_type === 'sessions') {
        // Session voucher — one session consumed per redemption.
        // Server validates treatment match (or same-duration treatment).
        await api.post(`/vouchers/${v.id}/redeem`, {
          bill_id: bill.id,
          treatment_id: appt.treatment_id,
          notes: `Checkout for appointment #${appointmentId}`,
        });
        await api.post(`/bills/${bill.id}/pay`, { method: 'voucher' });
        navigate('/', { replace: true });
        return;
      }

      // Monetary voucher — operator may specify a custom amount.
      // Default: min(remaining, total). Cap at min(remaining, total).
      const cap = Math.min(Number(v.remaining_value), total);
      const amountToUse = customAmount !== undefined
        ? +Math.min(cap, Math.max(0, Number(customAmount))).toFixed(2)
        : cap;
      if (amountToUse <= 0) { setError('Enter a positive amount'); setBusy(false); return; }

      await api.post(`/vouchers/${v.id}/redeem`, {
        amount: amountToUse,
        bill_id: bill.id,
        notes: `Checkout for appointment #${appointmentId}`,
      });

      if (Math.abs(amountToUse - total) < 0.01) {
        // Full coverage — close the bill as voucher.
        await api.post(`/bills/${bill.id}/pay`, { method: 'voucher' });
        navigate('/', { replace: true });
      } else {
        // Partial — record the voucher slice as a discount so the
        // remaining balance is what the operator needs to collect.
        // Existing bill.discount can already coexist; we ADD the
        // voucher amount to whatever's there.
        const newDiscount = +(Number(bill.discount || 0) + amountToUse).toFixed(2);
        const newReason = [bill.discount_reason, `Voucher ${v.code} −£${amountToUse.toFixed(2)}`].filter(Boolean).join(' + ');
        const r = await api.put(`/bills/${bill.id}/discount`, { discount: newDiscount, reason: newReason });
        setBill(r.bill);
        setShowVoucher(false);
        setVoucherCode(''); setVoucherLookup(null);
        setBusy(false);
        // Operator picks Cash/Card/Split to close the remaining balance.
      }
    } catch (e) {
      setError(e.message || 'Voucher redemption failed');
      setBusy(false);
    }
  }

  if (error && !appt) return <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>;
  if (!appt || !bill) return <div className="muted">Loading…</div>;

  const subtotal = Number(bill.subtotal || 0);
  const discount = Number(bill.discount || 0);
  const total = +Math.max(0, subtotal - discount + Number(tip || 0)).toFixed(2);
  // SPA-PAY-001 — any deposit the customer paid online via Stripe is
  // pre-credited. The operator only needs to collect `balance` at the
  // till; the backend auto-records the deposit portion in split_payments.
  const depositPaid = Number(appt.deposit_amount || 0);
  const balance = +Math.max(0, total - depositPaid).toFixed(2);
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
          {discount > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 6, color: '#ec4899' }}>
              <span>🏷 Discount{bill.discount_reason ? ` (${bill.discount_reason})` : ''}</span>
              <span>− {fmtMoney(discount)}</span>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <span>Tip</span><span>{fmtMoney(tip)}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, fontWeight: 700, fontSize: 18 }}>
            <span>Total</span><span>{fmtMoney(total)}</span>
          </div>
          {depositPaid > 0 && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 8, color: '#16a34a', fontSize: 14 }}>
                <span>💳 Deposit paid online</span>
                <span>− {fmtMoney(depositPaid)}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, fontWeight: 700, fontSize: 20, background: '#fdf6ec', border: '1px solid #e0c884', borderRadius: 8, padding: '10px 14px', color: '#1e3a6e' }}>
                <span>Balance due now</span><span>{fmtMoney(balance)}</span>
              </div>
            </>
          )}
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

            {/* SPA-DISCOUNT — receptionist-applied whole-bill discount.
                Quick-percentage buttons + custom £ + reason note. */}
            <div>
              <label>🏷 Discount</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {[10, 15, 20].map((p) => {
                  const amount = +(subtotal * p / 100).toFixed(2);
                  return (
                    <button
                      key={p}
                      onClick={() => saveDiscount(amount, `${p}% off`)}
                      style={{ flex: '0 0 auto', padding: '8px 12px' }}
                    >
                      {p}% (−{fmtMoney(amount)})
                    </button>
                  );
                })}
                <input
                  type="number" step="0.5" min="0"
                  placeholder="Custom £"
                  value={discount || ''}
                  onChange={(e) => saveDiscount(Number(e.target.value) || 0, discountReason)}
                  style={{ width: 90 }}
                />
                <input
                  type="text"
                  placeholder="Reason (e.g. Loyalty)"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  onBlur={(e) => discount > 0 && saveDiscount(discount, e.target.value)}
                  style={{ flex: 1, minWidth: 130 }}
                />
                {discount > 0 && (
                  <button onClick={() => saveDiscount(0, null)} style={{ fontSize: 12, padding: '4px 10px' }}>✕ Clear</button>
                )}
              </div>
            </div>

            <div>
              <label>Payment method</label>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {/* Order: Cash · Card · Voucher · Treatwell · Split */}
                <button
                  onClick={() => pay('cash')} disabled={busy}
                  style={{ flex: 1, padding: 14, minWidth: 80, background: '#ffedd5', color: '#9a3412', border: '1px solid #f97316', fontWeight: 600 }}
                >Cash</button>
                <button
                  onClick={() => pay('card')} disabled={busy}
                  style={{ flex: 1, padding: 14, minWidth: 80, background: '#fce7f3', color: '#9d174d', border: '1px solid #ec4899', fontWeight: 600 }}
                >Card</button>
                <button
                  onClick={() => setShowVoucher(v => !v)} disabled={busy}
                  style={{ flex: 1, padding: 14, minWidth: 80, background: showVoucher ? '#16a34a' : '#dcfce7', color: showVoucher ? 'white' : '#14532d', border: '1px solid #16a34a', fontWeight: 600 }}
                >🎁 Voucher</button>
                <button
                  onClick={() => { setShowTreatwell(true); setTreatwellAmount(String(total.toFixed(2))); }}
                  disabled={busy}
                  title="Customer paid Treatwell (full or partial). Pick the amount Treatwell covered — if less than total, the rest is collected at the till."
                  style={{ flex: 1, padding: 14, minWidth: 100, background: showTreatwell ? '#eab308' : '#fef9c3', color: showTreatwell ? 'white' : '#854d0e', border: '1px solid #eab308', fontWeight: 600 }}
                >🌐 Treatwell</button>
                <button
                  onClick={() => setShowSplit(true)} disabled={busy}
                  style={{ flex: 1, padding: 14, minWidth: 80, background: '#ede9fe', color: '#4c1d95', border: '1px solid #7c3aed', fontWeight: 600 }}
                >⇄ Split</button>
              </div>
              {appt.source === 'treatwell' && !showTreatwell && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 6, padding: '8px 12px', color: '#9a3412' }}>
                  🌐 This appointment came from <strong>Treatwell</strong>{appt.treatwell_payment_type === 'partial' ? ' as a deposit booking' : ''}.
                  Tap 🌐 Treatwell to record how much Treatwell paid — full closes the bill, partial leaves the balance to collect at the till.
                </div>
              )}
              {/* SPA-TREATWELL-PARTIAL — editable amount panel.
                  Full prepay → close bill as method='treatwell'.
                  Partial deposit → record as discount with reason
                  "Treatwell paid £X", bill stays open for Cash/Card/Split. */}
              {showTreatwell && (
                <TreatwellPaymentPanel
                  total={total}
                  busy={busy}
                  amount={treatwellAmount}
                  setAmount={setTreatwellAmount}
                  defaultsToPartial={appt.treatwell_payment_type === 'partial'}
                  onCancel={() => { setShowTreatwell(false); setTreatwellAmount(''); }}
                  onConfirm={async (amt) => {
                    if (Math.abs(amt - total) < 0.01) {
                      // Full Treatwell payment — close bill as treatwell-paid.
                      await pay('treatwell');
                    } else {
                      // Partial — record as discount, leave bill open
                      const newDiscount = +(Number(bill.discount || 0) + amt).toFixed(2);
                      const newReason = [bill.discount_reason, `Treatwell paid −£${amt.toFixed(2)}`].filter(Boolean).join(' + ');
                      const r = await api.put(`/bills/${bill.id}/discount`, { discount: newDiscount, reason: newReason });
                      setBill(r.bill);
                      setShowTreatwell(false);
                      setTreatwellAmount('');
                    }
                  }}
                />
              )}
            </div>

            {/* Voucher redemption panel */}
            {showVoucher && (
              <div style={{ background: '#fffbeb', border: '1px solid #C9A84C', borderRadius: 10, padding: 14 }} className="col">
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: '#1e3a6e' }}>🎁 Redeem Gift Voucher</div>
                {/* Legacy-voucher escape hatch — supports partial
                    amounts too. Toggle to a small panel where the
                    operator enters £X. Full bill → close as voucher;
                    partial → record as discount + leave bill open. */}
                {!showLegacy ? (
                  <button
                    onClick={() => { setShowLegacy(true); setLegacyAmount(String(total.toFixed(2))); }}
                    disabled={busy}
                    style={{ alignSelf: 'flex-start', fontSize: 12, padding: '6px 12px', background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', marginBottom: 8 }}
                    title="For vouchers from your previous EPOS — no code, just enter the amount the customer is using"
                  >
                    📜 No code — legacy voucher
                  </button>
                ) : (
                  <LegacyVoucherPanel
                    total={total}
                    busy={busy}
                    amount={legacyAmount}
                    setAmount={setLegacyAmount}
                    onCancel={() => { setShowLegacy(false); setLegacyAmount(''); }}
                    onConfirm={async (amt) => {
                      if (Math.abs(amt - total) < 0.01) {
                        if (!confirm(`Close this bill as paid by a legacy voucher (£${amt.toFixed(2)})?`)) return;
                        await pay('voucher');
                      } else {
                        // Partial — record as a discount, leave bill open
                        const newDiscount = +(Number(bill.discount || 0) + amt).toFixed(2);
                        const newReason = [bill.discount_reason, `Legacy voucher −£${amt.toFixed(2)}`].filter(Boolean).join(' + ');
                        const r = await api.put(`/bills/${bill.id}/discount`, { discount: newDiscount, reason: newReason });
                        setBill(r.bill);
                        setShowLegacy(false);
                        setLegacyAmount('');
                        setShowVoucher(false);
                      }
                    }}
                  />
                )}
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
                {voucherLookup && (() => {
                  const v = voucherLookup.voucher;
                  const isSessions = v.voucher_type === 'sessions';
                  // Treatment match warning for session vouchers — only block
                  // if the voucher is tied to a specific treatment AND it
                  // doesn't match this appointment's treatment.
                  const treatmentMismatch = isSessions && v.treatment_id && Number(v.treatment_id) !== Number(appt.treatment_id);
                  return (
                  <div style={{ marginTop: 10 }} className="col">
                    <div style={{ background: '#1e3a6e', color: 'white', borderRadius: 8, padding: '12px 16px' }}>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 700, color: '#C9A84C', letterSpacing: 1 }}>{v.code}</div>
                          {v.purchased_for && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>For {v.purchased_for}</div>}
                          {isSessions && (
                            <div style={{ fontSize: 11, marginTop: 4, background: '#fef3c7', color: '#854d0e', padding: '1px 8px', borderRadius: 10, display: 'inline-block', fontWeight: 600 }}>
                              🎟 {v.treatment_name || 'Any treatment'}
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {isSessions ? (
                            <>
                              <div style={{ fontSize: 20, fontWeight: 700, color: '#C9A84C' }}>{Number(v.sessions_remaining || 0)} / {Number(v.total_sessions || 0)}</div>
                              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>sessions left</div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontSize: 20, fontWeight: 700, color: '#C9A84C' }}>£{Number(v.remaining_value).toFixed(2)}</div>
                              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>available</div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {treatmentMismatch && (
                      <div style={{ fontSize: 13, color: '#991b1b', background: '#fee2e2', padding: '8px 12px', borderRadius: 8, marginTop: 8 }}>
                        ❌ This voucher is valid for <strong>{v.treatment_name}</strong> only — this appointment is a different treatment.
                      </div>
                    )}
                    {/* Monetary voucher — editable amount. Default is
                        min(remaining, total). Operator may choose to
                        redeem less (saves the rest for next visit).
                        If < total: applied as a discount, bill stays
                        open, operator picks Cash/Card for the balance. */}
                    {!isSessions && (
                      <MonetaryVoucherPanel
                        v={v}
                        total={total}
                        busy={busy}
                        onRedeem={(amt) => payWithVoucher(amt)}
                      />
                    )}
                    {isSessions && (
                      <button
                        className="gold"
                        onClick={() => payWithVoucher()}
                        disabled={busy || treatmentMismatch}
                        style={{ width: '100%', padding: 14, marginTop: 8 }}
                      >
                        {busy
                          ? 'Processing…'
                          : `Use 1 session & close bill (${Number(v.sessions_remaining || 0) - 1} left)`}
                      </button>
                    )}
                  </div>
                  );
                })()}
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

      {showSplit && (
        <SplitPaymentModal
          total={balance}
          billId={bill.id}
          appointmentId={appointmentId}
          onClose={() => setShowSplit(false)}
          onConfirm={async (split_payments, voucherRedemptions) => {
            // 1) Redeem each voucher first (cross-route — keeps bills.js
            //    free of voucher logic). 2) Then mark the bill split-paid.
            for (const vr of voucherRedemptions) {
              await api.post(`/vouchers/${vr.voucher_id}/redeem`, {
                amount: vr.amount,
                bill_id: bill.id,
                notes: `Split payment for appointment #${appointmentId}`,
              });
            }
            await pay('split', { split_payments });
          }}
        />
      )}

    </div>
  );
}

// ── Split payment modal ─────────────────────────────────────────────────
// Operator records how the customer actually split the bill — e.g. £30
// Cash + £20 Card, or £40 Voucher + £25 Card. Sum must equal the bill
// total. Backend stores the breakdown on bills.split_payments so the
// daily report attributes the cash/card/voucher portions correctly.
// Treatwell payment — full prepay or partial deposit. Operator types
// how much Treatwell paid. Full closes the bill as method='treatwell';
// partial is recorded as a discount with reason "Treatwell paid £X"
// so the till collects only the remainder.
function TreatwellPaymentPanel({ total, busy, amount, setAmount, defaultsToPartial, onCancel, onConfirm }) {
  const safe = Math.max(0, Math.min(total, Number(amount) || 0));
  const willClose = Math.abs(safe - total) < 0.01;
  const remainder = +(total - safe).toFixed(2);
  return (
    <div style={{ background: '#fef9c3', border: '1px solid #eab308', borderRadius: 8, padding: 10, marginTop: 6 }} className="col">
      <div style={{ fontSize: 13, fontWeight: 700, color: '#854d0e' }}>🌐 Treatwell payment</div>
      <div style={{ fontSize: 11, color: '#7a4f1e', marginBottom: 6 }}>
        {defaultsToPartial
          ? 'This booking is flagged as a Treatwell deposit. Enter what Treatwell paid; the balance is due at the till.'
          : 'Enter what Treatwell paid. If they covered the full price, the bill closes; otherwise the rest is due at the till.'}
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>£</span>
        <input
          type="number" step="0.01" min="0" max={total}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onFocus={(e) => e.target.select()}
          style={{ width: 110, fontSize: 16, fontWeight: 700, textAlign: 'right' }}
        />
        <button
          type="button"
          onClick={() => setAmount(String(total.toFixed(2)))}
          disabled={Math.abs(safe - total) < 0.01}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >Full £{total.toFixed(2)}</button>
      </div>
      <div style={{ fontSize: 12, color: '#7a4f1e', marginTop: 4 }}>
        {willClose
          ? `✓ Treatwell covered the full £${total.toFixed(2)} — closes the bill, Treatwell settles to your account minus commission.`
          : `Treatwell paid £${safe.toFixed(2)}. Remaining £${remainder.toFixed(2)} — pick Cash / Card / Split after.`}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button onClick={onCancel} disabled={busy} style={{ flex: 1, fontSize: 12 }}>Cancel</button>
        <button
          className="gold"
          onClick={() => onConfirm(safe)}
          disabled={busy || safe <= 0}
          style={{ flex: 2, fontSize: 13, padding: '8px 12px' }}
        >
          {busy ? 'Processing…' : willClose ? `Treatwell £${safe.toFixed(2)} & close bill` : `Treatwell paid £${safe.toFixed(2)}`}
        </button>
      </div>
    </div>
  );
}

// Legacy voucher (no code, from a previous EPOS). Operator enters £X
// the customer wants to use. Full = close bill as voucher; partial =
// recorded as discount on the bill with reason "Legacy voucher −£X".
function LegacyVoucherPanel({ total, busy, amount, setAmount, onCancel, onConfirm }) {
  const safe = Math.max(0, Math.min(total, Number(amount) || 0));
  const willClose = Math.abs(safe - total) < 0.01;
  const remainder = +(total - safe).toFixed(2);
  return (
    <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: 10, marginBottom: 8 }} className="col">
      <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>📜 Legacy voucher (no code)</div>
      <div style={{ fontSize: 11, color: '#7a4f1e', marginBottom: 6 }}>
        Enter the amount the customer is using from their old voucher. No code lookup; nothing recorded in the voucher table.
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>£</span>
        <input
          type="number" step="0.01" min="0" max={total}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onFocus={(e) => e.target.select()}
          style={{ width: 110, fontSize: 16, fontWeight: 700, textAlign: 'right' }}
        />
        <button
          type="button"
          onClick={() => setAmount(String(total.toFixed(2)))}
          disabled={Math.abs(safe - total) < 0.01}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >Full £{total.toFixed(2)}</button>
      </div>
      <div style={{ fontSize: 12, color: '#7a4f1e', marginTop: 4 }}>
        {willClose
          ? `✓ Covers the full £${total.toFixed(2)} bill — closes as voucher-paid.`
          : `Applies £${safe.toFixed(2)} as a discount. Remaining £${remainder.toFixed(2)} — pick Cash / Card / Split after.`}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button onClick={onCancel} disabled={busy} style={{ flex: 1, fontSize: 12 }}>Cancel</button>
        <button
          className="gold"
          onClick={() => onConfirm(safe)}
          disabled={busy || safe <= 0}
          style={{ flex: 2, fontSize: 13, padding: '8px 12px' }}
        >
          {busy ? 'Processing…' : willClose ? `Use £${safe.toFixed(2)} & close bill` : `Use £${safe.toFixed(2)} (legacy voucher)`}
        </button>
      </div>
    </div>
  );
}

// Editable-amount panel for monetary vouchers. Default = min(remaining,
// total). Operator can drop the amount lower to save the balance for
// next time — then the bill stays open and the receptionist picks
// another method (cash/card/split) for the rest.
function MonetaryVoucherPanel({ v, total, busy, onRedeem }) {
  const remaining = Number(v.remaining_value || 0);
  const cap = +Math.min(remaining, total).toFixed(2);
  const [amount, setAmount] = useState(cap);

  const safe = Math.max(0, Math.min(cap, Number(amount) || 0));
  const willClose = Math.abs(safe - total) < 0.01;
  const remainderAfter = +(total - safe).toFixed(2);

  return (
    <div className="col" style={{ gap: 8, marginTop: 8 }}>
      {remaining < total && (
        <div style={{ fontSize: 12, color: '#b45309', background: '#fef3c7', padding: '6px 10px', borderRadius: 6 }}>
          ⚠️ Voucher balance £{remaining.toFixed(2)} is less than bill total £{total.toFixed(2)}.
        </div>
      )}
      <div>
        <label style={{ fontSize: 12 }}>Amount to redeem</label>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>£</span>
          <input
            type="number" step="0.01" min="0" max={cap}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onFocus={(e) => e.target.select()}
            style={{ width: 110, fontSize: 16, fontWeight: 700, textAlign: 'right' }}
          />
          <button
            type="button"
            onClick={() => setAmount(cap)}
            disabled={safe === cap}
            style={{ fontSize: 11, padding: '4px 10px' }}
            title="Use the maximum"
          >Max £{cap.toFixed(2)}</button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {willClose
          ? `✓ Covers the full £${total.toFixed(2)} bill — pressing Redeem closes the bill.`
          : `Voucher pays £${safe.toFixed(2)}. Remaining £${remainderAfter.toFixed(2)} — pick Cash / Card / Split after.`}
      </div>
      <button
        className="gold"
        onClick={() => onRedeem(safe)}
        disabled={busy || safe <= 0}
        style={{ width: '100%', padding: 14, marginTop: 4 }}
      >
        {busy
          ? 'Processing…'
          : willClose
            ? `Redeem £${safe.toFixed(2)} & close bill`
            : `Redeem £${safe.toFixed(2)} (save £${(remaining - safe).toFixed(2)} for next time)`}
      </button>
    </div>
  );
}

function SplitPaymentModal({ total, onClose, onConfirm }) {
  const [rows, setRows] = useState([
    { method: 'cash', amount: '' },
    { method: 'card', amount: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const METHODS = [
    { id: 'cash',    label: 'Cash',    bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
    { id: 'card',    label: 'Card',    bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },
    { id: 'voucher', label: '🎁 Voucher', bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
  ];
  const methodStyle = (id) => METHODS.find(m => m.id === id) || METHODS[0];

  const allocated = +rows.reduce((s, r) => s + (Number(r.amount) || 0), 0).toFixed(2);
  const remaining = +(total - allocated).toFixed(2);
  const balanced  = Math.abs(remaining) < 0.005;

  // All voucher rows must be validated (code looked up) before we can confirm
  const voucherRows = rows.filter(r => r.method === 'voucher');
  const allVouchersReady = voucherRows.every(r => r.voucher && r.voucher.id);
  const voucherOverages = voucherRows.filter(r => r.voucher && Number(r.amount) > Number(r.voucher.remaining_value));

  function setRow(i, patch) {
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function addRow() {
    setRows(rs => [...rs, { method: 'cash', amount: '' }]);
  }
  function removeRow(i) {
    setRows(rs => rs.filter((_, idx) => idx !== i));
  }
  function autofillRemaining(i) {
    // One-click "use the remaining balance" on a row (capped by voucher balance if voucher)
    const others = rows.reduce((s, r, idx) => idx === i ? s : s + (Number(r.amount) || 0), 0);
    let fill = +(total - others).toFixed(2);
    const row = rows[i];
    if (row.method === 'voucher' && row.voucher) {
      fill = Math.min(fill, Number(row.voucher.remaining_value));
    }
    if (fill > 0) setRow(i, { amount: String(fill) });
  }

  async function lookupVoucher(i, code) {
    setRow(i, { voucherCode: code, voucherError: '', voucher: null });
    if (!code || !code.trim()) return;
    try {
      const r = await api.get(`/vouchers/lookup?code=${encodeURIComponent(code.trim().toUpperCase())}`);
      const v = r.voucher;
      if (v.status !== 'active') {
        setRow(i, { voucherError: `Voucher is ${v.status}`, voucher: null });
        return;
      }
      if (v.voucher_type === 'sessions') {
        // Sessions vouchers can't sensibly be split with cash — they
        // pay for one whole treatment. Operator must use the main
        // Voucher button, not split.
        setRow(i, { voucherError: 'Session vouchers can\'t be used in a split. Use the 🎁 Voucher button instead.', voucher: null });
        return;
      }
      setRow(i, { voucher: v, voucherError: '' });
    } catch (e) {
      setRow(i, { voucherError: e.message || 'Voucher not found', voucher: null });
    }
  }

  async function confirm() {
    setError('');
    if (!balanced) {
      setError(`Allocated £${allocated.toFixed(2)} — must equal £${total.toFixed(2)}.`);
      return;
    }
    if (!allVouchersReady) {
      setError('Check the voucher code(s) before confirming.');
      return;
    }
    if (voucherOverages.length) {
      setError(`Voucher amount exceeds available balance.`);
      return;
    }
    const clean = rows
      .filter(r => Number(r.amount) > 0)
      .map(r => ({ method: r.method, amount: +Number(r.amount).toFixed(2) }));
    if (clean.length === 0) {
      setError('Add at least one payment.');
      return;
    }
    // Voucher redemptions to fire BEFORE marking the bill paid, so the
    // parent can sequence: redeem vouchers → close bill as split.
    const voucherRedemptions = rows
      .filter(r => r.method === 'voucher' && r.voucher && Number(r.amount) > 0)
      .map(r => ({ voucher_id: r.voucher.id, amount: +Number(r.amount).toFixed(2) }));
    setBusy(true);
    try { await onConfirm(clean, voucherRedemptions); }
    catch (e) { setError(e.message || 'Split payment failed'); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* Flex-column layout so the balance header + Confirm footer stay
          visible on portrait mobile, while the payment-row list scrolls
          in between. Override the default .modal padding so we can pin
          the sticky bars edge-to-edge. */}
      <div
        className="modal"
        style={{ maxWidth: 460, padding: 0, display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Sticky header: title + bill total / remaining ────── */}
        <div style={{ flexShrink: 0, padding: '16px 18px 12px', borderBottom: '1px solid var(--border)', background: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>⇄ Split Payment</h3>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
          </div>
          <div style={{ background: '#1e3a6e', borderRadius: 10, padding: '12px 16px', color: 'white' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Bill total</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#C9A84C' }}>£{total.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  {balanced ? 'Balanced ✓' : remaining > 0 ? 'Remaining' : 'Over by'}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: balanced ? '#86efac' : remaining > 0 ? 'white' : '#fca5a5' }}>
                  £{Math.abs(remaining).toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Scrollable body: payment rows + notes ────────────── */}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 18px' }}>
        <div className="col" style={{ gap: 10 }}>
          {rows.map((r, i) => {
            const ms = methodStyle(r.method);
            const isVoucher = r.method === 'voucher';
            return (
              <div key={i} style={{
                padding: isVoucher ? '10px 12px' : 0,
                background: isVoucher ? ms.bg : 'transparent',
                border: isVoucher ? `1px solid ${ms.border}` : 'none',
                borderRadius: isVoucher ? 8 : 0,
              }}>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <select
                    value={r.method}
                    onChange={e => setRow(i, { method: e.target.value, voucherCode: '', voucher: null, voucherError: '' })}
                    style={{
                      width: 130,
                      background: isVoucher ? 'white' : ms.bg,
                      color: ms.text,
                      border: `2px solid ${ms.border}`,
                      fontWeight: 700,
                    }}
                  >
                    {METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <span style={{ fontWeight: 600, color: 'var(--muted)' }}>£</span>
                  <input
                    type="number" step="0.01" min="0"
                    value={r.amount}
                    onChange={e => setRow(i, { amount: e.target.value })}
                    onFocus={e => e.target.select()}
                    style={{ flex: 1, fontSize: 16, fontWeight: 600, textAlign: 'right' }}
                    placeholder="0.00"
                    disabled={isVoucher && !r.voucher}
                  />
                  <button
                    onClick={() => autofillRemaining(i)}
                    title="Fill with the remaining amount"
                    style={{ padding: '6px 10px', fontSize: 12 }}
                    disabled={isVoucher && !r.voucher}
                  >Use rest</button>
                  {rows.length > 1 && (
                    <button onClick={() => removeRow(i)} style={{ padding: '6px 10px', fontSize: 12 }} aria-label="Remove row">✕</button>
                  )}
                </div>

                {/* Voucher row — code lookup + balance display */}
                {isVoucher && (
                  <div style={{ marginTop: 8 }} className="col">
                    {!r.voucher ? (
                      <div className="row" style={{ gap: 6 }}>
                        <input
                          placeholder="SPA-XXXXXXXX"
                          value={r.voucherCode || ''}
                          onChange={e => setRow(i, { voucherCode: e.target.value.toUpperCase(), voucher: null, voucherError: '' })}
                          onKeyDown={e => e.key === 'Enter' && lookupVoucher(i, r.voucherCode)}
                          style={{ flex: 1, fontFamily: 'monospace', letterSpacing: 1 }}
                        />
                        <button
                          onClick={() => lookupVoucher(i, r.voucherCode)}
                          disabled={!r.voucherCode}
                          style={{ background: ms.border, color: 'white', fontWeight: 700, padding: '6px 14px' }}
                        >Check</button>
                      </div>
                    ) : (
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', background: 'white', borderRadius: 6, padding: '6px 12px', border: `1px solid ${ms.border}` }}>
                        <div>
                          <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: ms.text }}>{r.voucher.code}</div>
                          {r.voucher.purchased_for && <div className="muted" style={{ fontSize: 11 }}>For {r.voucher.purchased_for}</div>}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: ms.text }}>£{Number(r.voucher.remaining_value).toFixed(2)}</div>
                          <div className="muted" style={{ fontSize: 10 }}>available</div>
                        </div>
                        <button onClick={() => setRow(i, { voucher: null, voucherCode: '', amount: '' })} style={{ fontSize: 11, padding: '4px 8px' }}>Change</button>
                      </div>
                    )}
                    {r.voucherError && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{r.voucherError}</div>}
                    {r.voucher && Number(r.amount) > Number(r.voucher.remaining_value) && (
                      <div style={{ color: '#b45309', fontSize: 12 }}>
                        ⚠️ Amount exceeds voucher balance (£{Number(r.voucher.remaining_value).toFixed(2)}).
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length < 4 && (
            <button onClick={addRow} style={{ fontSize: 13, marginTop: 2 }}>+ Add another payment</button>
          )}
        </div>

        {error && <div style={{ color: 'var(--danger)', fontSize: 13, background: '#fee2e2', padding: '8px 12px', borderRadius: 6, marginTop: 10 }}>{error}</div>}

        <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
          The breakdown is stored on the bill so today's report attributes the cash portion to cash and the card portion to card — no money lost in a generic "split" bucket.
        </div>
        </div>{/* end scrollable body */}

        {/* ── Sticky footer: actions ──────────────────────────── */}
        <div style={{ flexShrink: 0, padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'white', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={confirm}
            disabled={busy || !balanced}
            style={{ flex: 1, maxWidth: 260, background: balanced ? '#C9A84C' : undefined, color: balanced ? '#1e3a6e' : undefined, fontWeight: 700 }}
          >
            {busy ? 'Processing…' : balanced ? `Take £${total.toFixed(2)} & close bill` : 'Balance the amounts'}
          </button>
        </div>
      </div>
    </div>
  );
}
