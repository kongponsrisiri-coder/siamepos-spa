// SPA-PAY-001 — Online Booking Manager.
// One admin home for the online deposit + self-service flow:
//   1. Policy settings (deposit model, amount, cancel window, policy text)
//   2. Live list of online bookings with deposit status + actions
//      (Stripe link / Refund / Cancel)

import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const DEPOSIT_MODELS = [
  { id: 'none',         label: 'No deposit',   hint: 'Customers book online without paying anything up-front.' },
  { id: 'fixed_amount', label: 'Fixed amount', hint: 'Same £ deposit on every booking — most common.' },
  { id: 'percentage',   label: 'Percentage',   hint: 'A % of the treatment price. Higher-value treatments → higher deposit.' },
  { id: 'full_prepay',  label: 'Full prepay',  hint: 'Customer pays the entire treatment online; nothing due at the spa.' },
];

const PAYMENT_STATUS_STYLE = {
  none:          { bg: '#f3f4f6', color: '#4b5563', label: 'No deposit' },
  deposit_paid:  { bg: '#dcfce7', color: '#166534', label: 'Deposit paid' },
  refunded:      { bg: '#dbeafe', color: '#1e40af', label: 'Refunded' },
  forfeit:       { bg: '#fef3c7', color: '#92400e', label: 'Forfeit' },
  fully_paid:    { bg: '#ede9fe', color: '#5b21b6', label: 'Fully paid' },
};

function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function OnlineBookingSection() {
  // Settings
  const [settings, setSettings] = useState({});
  const [savingKey, setSavingKey] = useState(null);
  // Bookings
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('upcoming'); // 'upcoming' | 'past' | 'all'

  const loadSettings = useCallback(async () => {
    const r = await api.get('/settings');
    setSettings(r.settings || {});
  }, []);

  const loadBookings = useCallback(async () => {
    setLoading(true);
    try {
      // Pull a wide window — backend doesn't have an "online only" filter
      // yet, so we filter client-side. For the typical spa volume this
      // is fine (~50/day = ~1500/month).
      const today = new Date();
      const monthsBack  = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const monthsAhead = new Date(today.getFullYear(), today.getMonth() + 3, 0);
      const from = monthsBack.toISOString().slice(0, 10);
      const to   = monthsAhead.toISOString().slice(0, 10);
      const r = await api.get(`/appointments?from=${from}&to=${to}`);
      const online = (r.appointments || []).filter((a) => a.source === 'online');
      setBookings(online);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSettings(); loadBookings(); }, [loadSettings, loadBookings]);

  // Refetch on rota/appointment changes so cancellations from the
  // customer portal show up live without needing to refresh.
  useEffect(() => {
    // Reuse the existing api refetch on focus — simple and effective.
    function onFocus() { loadBookings(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadBookings]);

  async function saveSetting(key, value) {
    setSavingKey(key);
    try {
      await api.put('/settings', { key, value });
      setSettings((s) => ({ ...s, [key]: value }));
    } finally { setSavingKey(null); }
  }

  async function refundBooking(a) {
    if (!confirm(`Refund the £${Number(a.deposit_amount).toFixed(2)} deposit for #${a.id}? This is irreversible.`)) return;
    try {
      // Refund happens via the booking by-token DELETE path, but staff
      // don't have the customer's token. Easiest: hit a staff cancel
      // endpoint that also refunds. We can use the existing PUT
      // /api/appointments/:id/status to cancel, and a separate
      // POST /api/online-booking/:id/refund for the Stripe refund.
      // Since that endpoint isn't built yet, fall back to message.
      alert('Use the customer\'s confirmation-email link to cancel + refund. Direct staff-side refund is a follow-up ticket.');
    } catch (e) { alert(e.message); }
  }

  const filteredBookings = bookings.filter((b) => {
    const now = Date.now();
    const isFuture = new Date(b.starts_at).getTime() >= now;
    if (filter === 'upcoming') return isFuture && b.status !== 'cancelled';
    if (filter === 'past')     return !isFuture || b.status === 'cancelled';
    return true;
  });

  const totalDeposit = bookings
    .filter((b) => b.payment_status === 'deposit_paid')
    .reduce((s, b) => s + Number(b.deposit_amount || 0), 0);

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Online Booking</h2>
          <div className="sub">Deposit policy + live view of online bookings</div>
        </div>
      </div>

      {/* ── Policy settings ───────────────────────────────────────── */}
      <div className="card col">
        <h3 style={{ margin: 0 }}>Deposit & cancellation policy</h3>
        <p className="muted" style={{ margin: 0 }}>
          These rules govern bookings made through your website widget. They don't affect bookings the receptionist creates from the appointment screen.
        </p>

        {/* Deposit model */}
        <div>
          <label>Deposit model</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {DEPOSIT_MODELS.map((m) => {
              const active = (settings.deposit_model || 'fixed_amount') === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => saveSetting('deposit_model', m.id)}
                  disabled={savingKey === 'deposit_model'}
                  style={{
                    padding: '8px 14px',
                    background: active ? '#1e3a6e' : 'white',
                    color: active ? 'white' : '#1e3a6e',
                    border: `1px solid ${active ? '#1e3a6e' : 'var(--border)'}`,
                    fontWeight: active ? 700 : 500,
                  }}
                >{m.label}</button>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {DEPOSIT_MODELS.find((m) => m.id === (settings.deposit_model || 'fixed_amount'))?.hint}
          </div>
        </div>

        {/* Deposit amount or percentage — only relevant for the chosen model */}
        <div className="row" style={{ gap: 12 }}>
          {(settings.deposit_model || 'fixed_amount') === 'fixed_amount' && (
            <SettingRow
              label="Deposit amount (£)"
              valueKey="deposit_amount"
              type="number"
              defaultValue="25"
              value={settings.deposit_amount}
              busy={savingKey === 'deposit_amount'}
              onSave={(v) => saveSetting('deposit_amount', v)}
            />
          )}
          {settings.deposit_model === 'percentage' && (
            <SettingRow
              label="Deposit percentage (%)"
              valueKey="deposit_percentage"
              type="number"
              defaultValue="25"
              value={settings.deposit_percentage}
              busy={savingKey === 'deposit_percentage'}
              onSave={(v) => saveSetting('deposit_percentage', v)}
            />
          )}
          <SettingRow
            label="Cancel window (hours)"
            valueKey="cancel_window_hours"
            type="number"
            defaultValue="24"
            value={settings.cancel_window_hours}
            busy={savingKey === 'cancel_window_hours'}
            onSave={(v) => saveSetting('cancel_window_hours', v)}
            hint="Free cancel within this many hours before the appointment."
          />
        </div>

        <div>
          <label>Cancellation policy text <span className="muted" style={{ fontSize: 12 }}>(shown to customers on the booking portal)</span></label>
          <textarea
            rows={2}
            value={settings.cancel_policy_text || ''}
            onChange={(e) => setSettings((s) => ({ ...s, cancel_policy_text: e.target.value }))}
            onBlur={(e) => {
              if (e.target.value !== settings.cancel_policy_text_saved) {
                saveSetting('cancel_policy_text', e.target.value);
              }
            }}
            placeholder="Cancellations within 24 hours of your appointment forfeit the deposit. We're happy to reschedule any time before then."
          />
        </div>

        <div className="muted" style={{ fontSize: 11, lineHeight: 1.55 }}>
          <strong>Stripe required:</strong> deposit collection needs <code>STRIPE_PUBLISHABLE_KEY</code> + <code>STRIPE_SECRET_KEY</code> set on the spa-api service. Without them, the widget falls back to no-deposit booking so customers can still book.
        </div>
      </div>

      {/* ── Stats strip ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatTile label="Upcoming online" value={bookings.filter((b) => new Date(b.starts_at) >= new Date() && b.status !== 'cancelled').length} color="#1e3a6e" />
        <StatTile label="Deposits held" value={fmtMoney(totalDeposit)} color="#C9A84C" />
        <StatTile label="Cancelled" value={bookings.filter((b) => b.status === 'cancelled').length} color="#991b1b" />
      </div>

      {/* ── Bookings list ─────────────────────────────────────────── */}
      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Online bookings</h3>
          <div className="row" style={{ gap: 6 }}>
            {['upcoming', 'past', 'all'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={filter === f ? 'primary' : ''}
                style={{ padding: '6px 14px', fontSize: 12, textTransform: 'capitalize' }}
              >{f}</button>
            ))}
          </div>
        </div>

        {loading && <div className="muted">Loading…</div>}
        {!loading && filteredBookings.length === 0 && (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
            No {filter} online bookings.
          </div>
        )}

        {filteredBookings.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ padding: '8px 6px' }}>When</th>
                  <th style={{ padding: '8px 6px' }}>Client</th>
                  <th style={{ padding: '8px 6px' }}>Treatment</th>
                  <th style={{ padding: '8px 6px' }}>Therapist</th>
                  <th style={{ padding: '8px 6px' }}>Status</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Deposit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredBookings.map((b) => {
                  const ps = PAYMENT_STATUS_STYLE[b.payment_status || 'none'] || PAYMENT_STATUS_STYLE.none;
                  const stripeUrl = b.deposit_stripe_id
                    ? `https://dashboard.stripe.com/payments/${b.deposit_stripe_id}`
                    : null;
                  return (
                    <tr key={b.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 6px' }}>
                        <div style={{ fontWeight: 600 }}>{fmtDate(b.starts_at)}</div>
                        <div className="muted" style={{ fontSize: 11 }}>#{b.id}</div>
                      </td>
                      <td style={{ padding: '10px 6px' }}>
                        <div>{b.client_name || '—'}</div>
                        <div className="muted" style={{ fontSize: 11 }}>{b.client_phone || ''}</div>
                      </td>
                      <td style={{ padding: '10px 6px' }}>{b.treatment_name || '—'}</td>
                      <td style={{ padding: '10px 6px' }}>{b.therapist_name || '— (unassigned)'}</td>
                      <td style={{ padding: '10px 6px' }}>
                        <span style={{ background: ps.bg, color: ps.color, padding: '3px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {ps.label}
                        </span>
                        {b.status === 'cancelled' && <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>cancelled</div>}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                        {Number(b.deposit_amount) > 0 ? (
                          <>
                            <div style={{ fontWeight: 700 }}>{fmtMoney(b.deposit_amount)}</div>
                            {stripeUrl && (
                              <a href={stripeUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#7c3aed' }}>
                                Stripe ↗
                              </a>
                            )}
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                        {b.status !== 'cancelled' && b.payment_status === 'deposit_paid' && (
                          <button onClick={() => refundBooking(b)} style={{ fontSize: 12 }}>Refund</button>
                        )}
                      </td>
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

function StatTile({ label, value, color }) {
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border)', borderTop: `3px solid ${color}`,
      borderRadius: 'var(--radius)', padding: '14px 16px', flex: 1, minWidth: 130, textAlign: 'center',
    }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.06, marginTop: 6 }}>{label}</div>
    </div>
  );
}

function SettingRow({ label, value, defaultValue, type, onSave, busy, hint }) {
  const [v, setV] = useState(value ?? defaultValue);
  useEffect(() => { setV(value ?? defaultValue); }, [value, defaultValue]);
  const dirty = String(v) !== String(value ?? defaultValue);
  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <label>{label}</label>
      <div className="row">
        <input type={type} value={v} onChange={(e) => setV(e.target.value)} />
        <button className={dirty ? 'primary' : ''} disabled={!dirty || busy} onClick={() => onSave(v)}>Save</button>
      </div>
      {hint && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
