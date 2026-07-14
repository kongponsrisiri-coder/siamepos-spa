// Admin → Vouchers — sell gift vouchers, track redemptions, link to clients
import React, { useEffect, useState, useCallback } from 'react';
import { api, getStaff } from '../../api.js';

function fmtMoney(n) { return `£${Number(n || 0).toFixed(2)}`; }
function fmtDate(d)  { return d ? new Date(d).toLocaleDateString('en-GB') : '—'; }

const STATUS_STYLE = {
  active:    { bg: '#dcfce7', color: '#14532d', label: 'Active' },
  used:      { bg: '#e0e7ff', color: '#3730a3', label: 'Used' },
  expired:   { bg: '#fee2e2', color: '#991b1b', label: 'Expired' },
  cancelled: { bg: '#f3f4f6', color: '#4b5563', label: 'Cancelled' },
};

export default function VouchersSection() {
  const [vouchers, setVouchers]   = useState([]);
  const [search, setSearch]       = useState('');
  const [filter, setFilter]       = useState('');
  const [modal, setModal]         = useState(null);  // null | 'create' | { voucher }
  const [detail, setDetail]       = useState(null);  // { voucher, redemptions }

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (filter) params.set('status', filter);
    const r = await api.get(`/vouchers?${params}`);
    setVouchers(r.vouchers || []);
  }, [search, filter]);

  useEffect(() => { load(); }, [load]);

  async function openDetail(v) {
    const r = await api.get(`/vouchers/${v.id}`);
    setDetail(r);
  }

  const totalActive = vouchers.filter(v => v.status === 'active').reduce((s, v) => s + Number(v.remaining_value), 0);

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* Header */}
      <div className="section-header">
        <div>
          <h2>Vouchers</h2>
          <div className="sub">
            {vouchers.filter(v => v.status === 'active').length} active · {fmtMoney(totalActive)} outstanding balance
          </div>
        </div>
        <button className="primary" onClick={() => setModal('create')}>+ Sell Voucher</button>
      </div>

      {/* Filters */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          placeholder="Search code, buyer, recipient…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 140 }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="used">Used</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {/* Voucher list */}
      <div className="col" style={{ gap: 8 }}>
        {vouchers.length === 0 && <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No vouchers found.</div>}
        {vouchers.map(v => {
          const ss = STATUS_STYLE[v.status] || STATUS_STYLE.active;
          const isSessions = v.voucher_type === 'sessions';
          const pct = isSessions
            ? (Number(v.total_sessions) > 0 ? Math.round((Number(v.sessions_remaining || 0) / Number(v.total_sessions)) * 100) : 0)
            : Math.round((Number(v.remaining_value) / Number(v.initial_value)) * 100);
          return (
            <div key={v.id} className="card" style={{ padding: 14, cursor: 'pointer' }} onClick={() => openDetail(v)}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, letterSpacing: 1, color: '#1e3a6e' }}>{v.code}</span>
                    <span style={{ fontSize: 11, background: ss.bg, color: ss.color, padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>{ss.label}</span>
                    {isSessions && (
                      <span style={{ fontSize: 11, background: '#fef3c7', color: '#854d0e', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>
                        🎟 Sessions
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                    {v.purchased_by && <span>Bought by <strong>{v.purchased_by}</strong></span>}
                    {v.purchased_for && <span> · For <strong>{v.purchased_for}</strong></span>}
                    {v.client_name && <span> · Linked to {v.client_name}</span>}
                    {v.sold_by_name && <span> · Sold by {v.sold_by_name}</span>}
                  </div>
                  {v.expires_at && (
                    <div style={{ fontSize: 12, color: new Date(v.expires_at) < new Date() ? 'var(--danger)' : 'var(--muted)', marginTop: 2 }}>
                      Expires {fmtDate(v.expires_at)}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {isSessions ? (
                    <>
                      <div style={{ fontWeight: 700, fontSize: 18, color: '#1e3a6e' }}>
                        {Number(v.sessions_remaining || 0)} / {Number(v.total_sessions || 0)} sessions
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {v.treatment_name || 'Any treatment'} · paid {fmtMoney(v.initial_value)}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 700, fontSize: 18, color: '#1e3a6e' }}>{fmtMoney(v.remaining_value)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>of {fmtMoney(v.initial_value)}</div>
                    </>
                  )}
                  {/* Balance bar */}
                  <div style={{ width: 80, height: 4, background: '#e5e7eb', borderRadius: 2, marginTop: 4, marginLeft: 'auto' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: v.status === 'active' ? 'var(--gold)' : '#9ca3af', borderRadius: 2 }} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create modal */}
      {modal === 'create' && (
        <CreateVoucherModal
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}

      {/* Detail / redemption history modal */}
      {detail && (
        <VoucherDetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          onUpdated={() => { load(); openDetail(detail.voucher); }}
        />
      )}
    </div>
  );
}

// ── Create voucher modal ──────────────────────────────────────────────────────
function CreateVoucherModal({ onClose, onSaved }) {
  const [type, setType]             = useState('monetary');          // 'monetary' | 'sessions'
  const [value, setValue]           = useState('');                  // money: amount; sessions: sale price
  const [sessions, setSessions]     = useState('');                  // sessions only
  const [treatmentId, setTreatmentId] = useState('');                // sessions only ('' = any)
  const [treatments, setTreatments] = useState([]);
  const [purchasedBy, setPurchasedBy] = useState('');
  const [purchasedFor, setPurchasedFor] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [paymentMethod, setPaymentMethod] = useState(''); // 'cash' | 'card' | 'split'
  const [expiresAt, setExpiresAt]   = useState('');
  const [notes, setNotes]           = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');
  const [created, setCreated]       = useState(null);

  // Quick-value presets for monetary
  const PRESETS = [25, 50, 75, 100, 150];
  const SESSION_PRESETS = [3, 5, 10];

  // Load treatments for the session picker (lazy — only when needed)
  useEffect(() => {
    if (type !== 'sessions' || treatments.length) return;
    api.get('/treatments').then((r) => setTreatments(r.treatments || [])).catch(() => {});
  }, [type, treatments.length]);

  // Auto-fill sale price when picking treatment + sessions count.
  // Operator can still override afterwards (e.g. for a bundle discount).
  function autofillSessionsValue(nextTreatmentId, nextSessions) {
    const tid = nextTreatmentId !== undefined ? nextTreatmentId : treatmentId;
    const n   = nextSessions    !== undefined ? nextSessions    : sessions;
    if (!tid || !n) return;
    const t = treatments.find((x) => String(x.id) === String(tid));
    if (!t) return;
    setValue(String((Number(t.price) * Number(n)).toFixed(2)));
  }

  async function submit() {
    if (!value || Number(value) <= 0) { setError('Please enter a sale price.'); return; }
    if (type === 'sessions') {
      if (!sessions || Number(sessions) <= 0) { setError('Please enter the number of sessions.'); return; }
    }
    if (!paymentMethod) { setError('Please record how the customer paid (Cash / Card / Split).'); return; }
    setBusy(true); setError('');
    try {
      const body = {
        value: Number(value),
        purchased_by: purchasedBy.trim() || null,
        purchased_for: purchasedFor.trim() || null,
        recipient_email: recipientEmail.trim() || null,
        payment_method: paymentMethod,
        expires_at: expiresAt || null,
        notes: notes.trim() || null,
      };
      if (type === 'sessions') {
        body.voucher_type   = 'sessions';
        body.total_sessions = Number(sessions);
        body.treatment_id   = treatmentId ? Number(treatmentId) : null;
      }
      const r = await api.post('/vouchers', body);
      setCreated(r.voucher);
    } catch (e) {
      setError(e.message || 'Failed to create voucher');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>🎁 Sell Gift Voucher</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        {created ? (
          // Success state — show the code to print/hand over
          <div className="col" style={{ gap: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 40 }}>🎉</div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Voucher Created!</div>
            <div style={{ background: '#1e3a6e', color: 'white', borderRadius: 12, padding: '20px 28px' }}>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginBottom: 4 }}>Voucher Code</div>
              <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, letterSpacing: 3, color: 'var(--gold)' }}>{created.code}</div>
              {created.voucher_type === 'sessions' ? (
                <>
                  <div style={{ fontSize: 20, fontWeight: 700, marginTop: 10 }}>
                    {created.total_sessions} session{created.total_sessions === 1 ? '' : 's'}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 2, opacity: 0.8 }}>
                    {created.treatment_id
                      ? (treatments.find(t => t.id === created.treatment_id)?.name || 'a treatment')
                      : 'any treatment'}
                    {' · paid £'}{Number(created.initial_value).toFixed(2)}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 10 }}>£{Number(created.initial_value).toFixed(2)}</div>
              )}
              {created.purchased_for && <div style={{ fontSize: 14, marginTop: 4, opacity: 0.8 }}>For {created.purchased_for}</div>}
              {created.expires_at && <div style={{ fontSize: 12, marginTop: 2, opacity: 0.65 }}>Expires {fmtDate(created.expires_at)}</div>}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {created.recipient_email
                ? <>📧 Voucher emailed to <strong>{created.recipient_email}</strong>. Also hand them this code if they want a paper copy.</>
                : 'Hand this code to the customer. They present it at checkout to redeem.'}
            </div>
            <button className="primary" onClick={onSaved} style={{ width: '100%' }}>Done</button>
          </div>
        ) : (
          <div className="col" style={{ gap: 14 }}>
            {/* Voucher type tabs */}
            <div className="row" style={{ gap: 6, padding: 4, background: '#f3f4f6', borderRadius: 10 }}>
              <button
                onClick={() => { setType('monetary'); setValue(''); }}
                className={type === 'monetary' ? 'primary' : ''}
                style={{ flex: 1, padding: '10px 14px', fontSize: 13, fontWeight: 600 }}
              >💷 Money voucher</button>
              <button
                onClick={() => { setType('sessions'); setValue(''); }}
                className={type === 'sessions' ? 'primary' : ''}
                style={{ flex: 1, padding: '10px 14px', fontSize: 13, fontWeight: 600 }}
              >🎟 Session bundle</button>
            </div>

            {/* Sessions-only — treatment + count */}
            {type === 'sessions' && (
              <>
                <div>
                  <label>Treatment</label>
                  <select
                    value={treatmentId}
                    onChange={e => { setTreatmentId(e.target.value); autofillSessionsValue(e.target.value, undefined); }}
                  >
                    <option value="">— Any treatment (multi-treatment bundle) —</option>
                    {treatments.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.duration_minutes}min · £{Number(t.price).toFixed(2)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Sessions *</label>
                  <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                    {SESSION_PRESETS.map(n => (
                      <button
                        key={n}
                        onClick={() => { setSessions(String(n)); autofillSessionsValue(undefined, n); }}
                        className={sessions === String(n) ? 'primary' : ''}
                        style={{ padding: '6px 14px', fontSize: 13 }}
                      >{n} sessions</button>
                    ))}
                  </div>
                  <input
                    type="number" min="1" step="1"
                    placeholder="Or enter custom count…"
                    value={sessions}
                    onChange={e => { setSessions(e.target.value); autofillSessionsValue(undefined, e.target.value); }}
                  />
                </div>
              </>
            )}

            {/* Value — labelled differently per type */}
            <div>
              <label>
                {type === 'sessions' ? 'Sale price *' : 'Voucher value *'}
                {type === 'sessions' && treatmentId && sessions && (
                  <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
                    (auto-filled from {sessions} × treatment price — adjust for a bundle discount)
                  </span>
                )}
              </label>
              {type === 'monetary' && (
                <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                  {PRESETS.map(p => (
                    <button key={p} onClick={() => setValue(String(p))} className={value === String(p) ? 'primary' : ''} style={{ padding: '6px 12px', fontSize: 13 }}>£{p}</button>
                  ))}
                </div>
              )}
              <input type="number" min="1" step="0.01" placeholder={type === 'sessions' ? 'Bundle sale price (£)' : 'Or enter custom amount…'} value={value} onChange={e => setValue(e.target.value)} />
            </div>

            <div className="row" style={{ gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label>Purchased by</label>
                <input placeholder="Buyer's name" value={purchasedBy} onChange={e => setPurchasedBy(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label>Gift for</label>
                <input placeholder="Recipient's name" value={purchasedFor} onChange={e => setPurchasedFor(e.target.value)} />
              </div>
            </div>

            {/* Recipient email — if set, the voucher is auto-emailed to
                them with the code + redemption details on save. */}
            <div>
              <label>
                Recipient email
                <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
                  (optional — if set, we email the voucher to them on save)
                </span>
              </label>
              <input
                type="email"
                placeholder="name@example.com"
                value={recipientEmail}
                onChange={e => setRecipientEmail(e.target.value)}
              />
            </div>

            <div>
              <label>Expiry date (optional)</label>
              <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
            </div>

            <div>
              <label>Notes (optional)</label>
              <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any notes…" />
            </div>

            {/* Payment method — required. Pre-CTA so the operator can't
                forget to record how the cash came in. Colours mirror the
                Checkout palette so the two screens read the same. */}
            <div>
              <label>How did the customer pay? *</label>
              <div className="row" style={{ gap: 8 }}>
                {[
                  { id: 'cash',  label: 'Cash',  bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
                  { id: 'card',  label: 'Card',  bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },
                  { id: 'split', label: 'Split', bg: '#ede9fe', border: '#7c3aed', text: '#4c1d95' },
                ].map(m => {
                  const active = paymentMethod === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setPaymentMethod(m.id)}
                      style={{
                        flex: 1,
                        padding: '12px 14px',
                        background: active ? m.border : m.bg,
                        color:      active ? '#fff'    : m.text,
                        border:     `2px solid ${m.border}`,
                        borderRadius: 8,
                        fontWeight: 700,
                        fontSize: 14,
                        cursor: 'pointer',
                      }}
                    >{m.label}</button>
                  );
                })}
              </div>
            </div>

            {error && <div style={{ color: 'var(--danger)', fontSize: 13, background: '#fee2e2', padding: '8px 12px', borderRadius: 6 }}>{error}</div>}

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={submit} disabled={busy || !paymentMethod}>
                {busy
                  ? 'Creating…'
                  : paymentMethod
                    ? `Take £${Number(value || 0).toFixed(2)} ${paymentMethod} & issue voucher`
                    : 'Create Voucher'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Voucher detail + redemption history modal ─────────────────────────────────
function VoucherDetailModal({ detail, onClose, onUpdated }) {
  const { voucher: v, redemptions } = detail;
  const ss = STATUS_STYLE[v.status] || STATUS_STYLE.active;
  const staff = getStaff();
  const isAdmin = ['admin', 'manager'].includes(staff?.role);

  // Client search for linking
  const [clientQuery, setClientQuery] = useState('');
  const [clientResults, setClientResults] = useState([]);

  useEffect(() => {
    if (!clientQuery.trim()) { setClientResults([]); return; }
    const t = setTimeout(() => {
      api.get(`/clients?q=${encodeURIComponent(clientQuery)}`).then(r => setClientResults(r.clients || []));
    }, 250);
    return () => clearTimeout(t);
  }, [clientQuery]);

  async function linkClient(client) {
    await api.put(`/vouchers/${v.id}`, { client_id: client.id });
    setClientQuery(''); setClientResults([]);
    onUpdated();
  }

  async function cancelVoucher() {
    if (!confirm(`Cancel voucher ${v.code}? This cannot be undone.`)) return;
    await api.del(`/vouchers/${v.id}`);
    onClose();
    onUpdated();
  }

  // Permanent delete — admin cleanup for test/demo vouchers (works even if the
  // voucher was redeemed during a demo). Two-step inline confirm instead of a
  // browser dialog (window.confirm/prompt are unreliable in the Electron till).
  const [confirmDel, setConfirmDel] = useState(false);
  async function deleteVoucherPermanently() {
    if (!confirmDel) { setConfirmDel(true); return; }
    await api.del(`/vouchers/${v.id}?permanent=1`);
    onClose();
    onUpdated();
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>🎁 {v.code}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Summary bar */}
        <div style={{ background: '#1e3a6e', borderRadius: 10, padding: '16px 20px', color: 'white', marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                {v.voucher_type === 'sessions' ? 'Sessions remaining' : 'Remaining'}
              </div>
              {v.voucher_type === 'sessions' ? (
                <>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--gold)' }}>
                    {Number(v.sessions_remaining || 0)} / {Number(v.total_sessions || 0)}
                  </div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
                    {v.treatment_name || 'Any treatment'} · sold for {fmtMoney(v.initial_value)}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--gold)' }}>{fmtMoney(v.remaining_value)}</div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>of {fmtMoney(v.initial_value)} original</div>
                </>
              )}
            </div>
            <span style={{ fontSize: 11, background: ss.bg, color: ss.color, padding: '4px 12px', borderRadius: 12, fontWeight: 700 }}>{ss.label}</span>
          </div>
        </div>

        <div className="col" style={{ gap: 10 }}>
          {/* Meta */}
          <div className="card col" style={{ padding: 12, gap: 6 }}>
            {v.purchased_by && <div style={{ fontSize: 13 }}><span className="muted">Bought by </span><strong>{v.purchased_by}</strong></div>}
            {v.purchased_for && <div style={{ fontSize: 13 }}><span className="muted">Gift for </span><strong>{v.purchased_for}</strong></div>}
            {v.sold_by_name && <div style={{ fontSize: 13 }}><span className="muted">Sold by </span>{v.sold_by_name}</div>}
            <div style={{ fontSize: 13 }}><span className="muted">Sold </span>{fmtDate(v.purchased_at)}</div>
            {v.expires_at && <div style={{ fontSize: 13, color: new Date(v.expires_at) < new Date() ? 'var(--danger)' : 'inherit' }}><span className="muted">Expires </span>{fmtDate(v.expires_at)}</div>}
            {v.notes && <div style={{ fontSize: 13 }}><span className="muted">Notes </span>{v.notes}</div>}
          </div>

          {/* Link to client */}
          <div>
            <label style={{ fontSize: 13 }}>Linked client: <strong>{v.client_name || 'None'}</strong></label>
            <input
              placeholder="Search to link a client…"
              value={clientQuery}
              onChange={e => setClientQuery(e.target.value)}
              style={{ marginTop: 4 }}
            />
            {clientResults.length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, background: 'white', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
                {clientResults.map(c => (
                  <div key={c.id} onClick={() => linkClient(c)}
                    style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                    onMouseLeave={e => e.currentTarget.style.background = 'white'}
                  >{c.name}{c.phone && <span className="muted"> · {c.phone}</span>}</div>
                ))}
              </div>
            )}
          </div>

          {/* Redemption history */}
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Redemption History</div>
            {redemptions.length === 0 ? (
              <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>Not yet redeemed.</div>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {redemptions.map(r => (
                  <div key={r.id} style={{ padding: '8px 12px', background: '#f9fafb', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong style={{ color: '#1e3a6e' }}>{fmtMoney(r.amount_used)} used</strong>
                      <span className="muted">{new Date(r.redeemed_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </div>
                    {r.redeemed_by_name && <div className="muted">By {r.redeemed_by_name}{r.bill_id ? ` · Bill #${r.bill_id}` : ''}</div>}
                    {r.notes && <div className="muted">{r.notes}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          {isAdmin && (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
              {/* Permanent delete — for test/demo vouchers. Deletes the voucher
                  AND its redemption history, removing it from lists + reports.
                  Real customer vouchers should be cancelled instead. */}
              <button
                onClick={deleteVoucherPermanently}
                style={confirmDel
                  ? { background: 'var(--danger)', color: 'white', fontWeight: 700 }
                  : { background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' }}
              >
                {confirmDel ? 'Really delete? Click again to erase it (incl. from reports)' : 'Delete permanently'}
              </button>
              {v.status === 'active' && (
                <button className="danger" onClick={cancelVoucher}>Cancel Voucher</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
