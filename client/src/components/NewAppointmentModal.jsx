// NewAppointmentModal — handles both CREATE and EDIT
// Props:
//   appointment    — existing appointment object (edit mode) or null (create mode)
//   defaultDate    — pre-fill date (create)
//   defaultTherapistId — pre-fill therapist (click-to-book)
//   defaultStartsAt    — pre-fill time as 'HH:MM' (click-to-book)
//   onClose / onSaved

import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// SPA-TREATWELL-COLOR — small inline selector for the Treatwell
// payment type. Drives the timeline colour (green = full prepay,
// amber = partial deposit). PATCHes the appointment.
function TreatwellTypeBlock({ appointment }) {
  const [val, setVal] = useState(appointment.treatwell_payment_type || 'partial');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function save(next) {
    setBusy(true);
    try {
      await api.put(`/appointments/${appointment.id}`, { treatwell_payment_type: next });
      setVal(next);
      appointment.treatwell_payment_type = next;
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {} finally { setBusy(false); }
  }
  return (
    <div style={{
      background: val === 'full' ? '#dcfce7' : '#fef3c7',
      border: `1px solid ${val === 'full' ? '#86efac' : '#fcd34d'}`,
      borderRadius: 8,
      padding: '10px 14px',
      marginBottom: 14,
      fontSize: 13,
    }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ color: val === 'full' ? '#166534' : '#92400e' }}>
          🌐 <strong>Treatwell payment:</strong>{' '}
          {val === 'full'
            ? 'Customer paid Treatwell in full — no till charge'
            : 'Customer paid Treatwell a deposit — balance due at till'}
          {saved && <span style={{ marginLeft: 6 }}>✓</span>}
        </span>
        <div className="row" style={{ gap: 4 }}>
          <button
            onClick={() => save('full')}
            disabled={busy || val === 'full'}
            style={{ fontSize: 11, padding: '4px 10px', background: val === 'full' ? '#16a34a' : 'white', color: val === 'full' ? 'white' : '#166534', border: '1px solid #16a34a', fontWeight: 700 }}
          >Full</button>
          <button
            onClick={() => save('partial')}
            disabled={busy || val === 'partial'}
            style={{ fontSize: 11, padding: '4px 10px', background: val === 'partial' ? '#f59e0b' : 'white', color: val === 'partial' ? 'white' : '#92400e', border: '1px solid #f59e0b', fontWeight: 700 }}
          >Partial</button>
        </div>
      </div>
    </div>
  );
}

// SPA-PAYMENT-EDIT — Amend the payment method on a closed bill. Loads
// the bill for the appointment so we know the current method, then
// shows a method picker. Single-method changes only — switching to
// 'split' from the timeline modal is too complex; route those edits
// to Admin → Bills.
function PaymentEditBlock({ appointment, onUpdated }) {
  const [bill, setBill]   = useState(null);
  const [open, setOpen]   = useState(false);
  const [newMethod, setNewMethod] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk]       = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.get(`/bills?appointment_id=${appointment.id}`);
        const b = (r.bills || []).find((x) => x.appointment_id === appointment.id);
        if (alive) setBill(b || null);
      } catch {}
    })();
    return () => { alive = false; };
  }, [appointment.id]);

  if (!bill) return null;

  const METHODS = [
    { id: 'cash',      label: 'Cash',      bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
    { id: 'card',      label: 'Card',      bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },
    { id: 'voucher',   label: '🎁 Voucher', bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
    { id: 'treatwell', label: '🌐 Treatwell', bg: '#fef9c3', border: '#eab308', text: '#854d0e' },
  ];

  async function save() {
    if (!newMethod || newMethod === bill.payment_method) { setOpen(false); return; }
    setBusy(true); setError('');
    try {
      const r = await api.put(`/bills/${bill.id}/method`, { method: newMethod });
      setBill(r.bill);
      setOpen(false); setNewMethod('');
      setOk(true);
      setTimeout(() => setOk(false), 1800);
      onUpdated && onUpdated(r.bill);
    } catch (e) {
      setError(e.message || 'Failed to update method');
    } finally { setBusy(false); }
  }

  const currentLabel = bill.payment_method === 'split'
    ? '⇄ Split (edit via Admin → Bills)'
    : (METHODS.find((m) => m.id === bill.payment_method)?.label || bill.payment_method || '—');

  return (
    <div style={{
      background: '#f3f4f6',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '10px 14px',
      marginBottom: 14,
      fontSize: 13,
    }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span>
          💰 Paid by <strong>{currentLabel}</strong> · {bill.subtotal && bill.total ? `£${Number(bill.total).toFixed(2)}` : ''}
          {ok && <span style={{ color: '#16a34a', marginLeft: 8 }}>✓ updated</span>}
        </span>
        {bill.payment_method !== 'split' && !open && (
          <button onClick={() => { setOpen(true); setNewMethod(bill.payment_method); }} style={{ fontSize: 12, padding: '4px 10px' }}>
            Edit
          </button>
        )}
      </div>
      {open && (
        <div className="col" style={{ marginTop: 8, gap: 8 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {METHODS.map((m) => {
              const active = newMethod === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setNewMethod(m.id)}
                  style={{
                    flex: '1 1 100px',
                    padding: '8px 10px',
                    background: active ? m.border : m.bg,
                    color: active ? 'white' : m.text,
                    border: `2px solid ${m.border}`,
                    fontWeight: 700,
                    borderRadius: 6,
                  }}
                >{m.label}</button>
              );
            })}
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button onClick={() => { setOpen(false); setNewMethod(''); setError(''); }} style={{ fontSize: 12, padding: '4px 12px' }}>Cancel</button>
            <button onClick={save} disabled={busy || !newMethod || newMethod === bill.payment_method} className="primary" style={{ fontSize: 12, padding: '4px 14px' }}>
              {busy ? 'Saving…' : 'Save change'}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            For a deposit-paid booking, the deposit row is preserved automatically.
            Splitting into multiple methods? Use <strong>Admin → 🧾 Bills</strong>.
          </div>
        </div>
      )}
    </div>
  );
}

// SPA-PAY-002 — Generates a deposit-payment link for a booking the
// receptionist created over the phone/in-person. Shown only when no
// deposit has been paid yet. Once generated, the link can be copied
// or shared via WhatsApp (deep-link) or email.
function PaymentLinkBlock({ appointment }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const isPending = appointment.payment_status === 'deposit_pending';

  async function generate() {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/appointments/${appointment.id}/payment-link`);
      setLink(r.url);
    } catch (e) {
      setError(e.message || 'Could not generate link. Check that Stripe is configured.');
    } finally { setBusy(false); }
  }

  function copyLink() {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const waText = link
    ? `Hi! Here's the deposit link for your booking at ${appointment.spa_name || 'the spa'}:\n${link}`
    : '';
  const waUrl = link ? `https://wa.me/?text=${encodeURIComponent(waText)}` : '';

  return (
    <div style={{
      background: isPending ? '#fef3c7' : '#fdf6ec',
      border: `1px solid ${isPending ? '#fcd34d' : '#e0c884'}`,
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 14,
      fontSize: 13,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ color: '#7a4f1e' }}>
          💳 <strong>{isPending ? 'Deposit link sent — awaiting payment' : 'Deposit not collected'}</strong>
        </span>
        {!link && (
          <button onClick={generate} disabled={busy} style={{ background: '#C9A84C', color: '#1e3a6e', fontWeight: 700, padding: '6px 12px', fontSize: 12, border: 'none', borderRadius: 6 }}>
            {busy ? 'Generating…' : isPending ? '🔄 New link' : '💳 Request deposit by link'}
          </button>
        )}
      </div>
      {error && <div style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
      {link && (
        <div style={{ marginTop: 10 }}>
          <input
            value={link}
            readOnly
            onFocus={(e) => e.target.select()}
            style={{ width: '100%', padding: 8, fontSize: 12, fontFamily: 'monospace' }}
          />
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <button onClick={copyLink} style={{ flex: 1, padding: '6px 10px', fontSize: 12 }}>{copied ? '✓ Copied' : '📋 Copy'}</button>
            <a href={waUrl} target="_blank" rel="noreferrer" style={{ flex: 1, padding: '6px 10px', fontSize: 12, background: '#25D366', color: 'white', textAlign: 'center', textDecoration: 'none', borderRadius: 6, fontWeight: 600 }}>
              📱 WhatsApp
            </a>
            {appointment.client_email && (
              <a href={`mailto:${appointment.client_email}?subject=Your%20deposit%20link&body=${encodeURIComponent(`Hi,\n\nHere's the deposit link for your booking:\n\n${link}\n\nThanks!`)}`} style={{ flex: 1, padding: '6px 10px', fontSize: 12, background: '#1e3a6e', color: 'white', textAlign: 'center', textDecoration: 'none', borderRadius: 6, fontWeight: 600 }}>
                ✉️ Email
              </a>
            )}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            The customer's booking is held as <strong>deposit_pending</strong>. They tap the link and pay — the booking auto-confirms.
          </div>
        </div>
      )}
    </div>
  );
}

// Cancellation + no-show are handled by the dedicated "Cancel" button on
// the timeline — and the timeline filters those rows out anyway — so the
// edit-mode dropdown only exposes the "live" statuses. If an appointment
// happens to already be in cancelled / no_show (legacy data, restored
// row, etc.) we still surface that value as a one-off option so it
// renders correctly until the user moves it back to a live state.
const STATUSES = ['booked', 'in_progress', 'completed'];

function pad(n) { return String(n).padStart(2, '0'); }

// Rota helpers — mirror AppointmentScreen so this dropdown shows the same
// "who's actually on shift today" picture as the timeline.
function isWorkingOn(therapistId, dateStr, weeklyRota, overrides) {
  if (!dateStr) return true;
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
  const override = overrides.find(o => o.therapist_id === therapistId && String(o.date).slice(0, 10) === dateStr);
  if (override) return Boolean(override.is_working);
  if (weeklyRota.some(r => r.therapist_id === therapistId && r.day_of_week === dayOfWeek)) return true;
  // Backwards compat: a therapist with NO rota at all is treated as available
  // (full-day), matching availability.js / AppointmentScreen.
  return !weeklyRota.some(r => r.therapist_id === therapistId);
}
function workHoursOn(therapistId, dateStr, weeklyRota, overrides) {
  if (!dateStr) return null;
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
  const override = overrides.find(o => o.therapist_id === therapistId && String(o.date).slice(0, 10) === dateStr);
  if (override && override.is_working && override.start_time && override.end_time) {
    return `${String(override.start_time).slice(0, 5)}–${String(override.end_time).slice(0, 5)}`;
  }
  const entry = weeklyRota.find(r => r.therapist_id === therapistId && r.day_of_week === dayOfWeek);
  if (entry && entry.start_time && entry.end_time) {
    return `${String(entry.start_time).slice(0, 5)}–${String(entry.end_time).slice(0, 5)}`;
  }
  return null;
}

export default function NewAppointmentModal({
  appointment,
  defaultDate,
  defaultTherapistId,
  defaultStartsAt,
  onClose,
  onSaved,
  // legacy prop name support
  onCreated,
}) {
  const isEdit = Boolean(appointment);
  const handleSaved = onSaved || onCreated || (() => {});

  // ── Reference data ────────────────────────────────────────────────────────
  const [treatments, setTreatments] = useState([]);
  const [therapists, setTherapists] = useState([]);
  const [rooms, setRooms]           = useState([]);
  const [clients, setClients]       = useState([]);

  // ── Form fields ───────────────────────────────────────────────────────────
  const [clientId, setClientId]         = useState(appointment?.client_id || null);
  const [clientName, setClientName]     = useState('');  // display name once selected
  const [clientQuery, setClientQuery]   = useState('');
  // New-client form — full intake so the appointment links to a proper
  // client record (not a name+phone stub). Mirrors ClientSearchScreen's
  // New Client modal field list.
  const [newClient, setNewClient] = useState({
    name: '', phone: '', email: '', date_of_birth: '',
    emergency_contact_name: '', emergency_contact_phone: '',
    gp_name: '', gp_surgery: '',
    gdpr_consent: true, marketing_consent: false, notes: '',
  });
  const setNew = (k, v) => setNewClient((s) => ({ ...s, [k]: v }));
  const [showNewClient, setShowNewClient] = useState(false);

  const [treatmentId, setTreatmentId] = useState(appointment?.treatment_id || null);
  const [therapistId, setTherapistId] = useState(
    appointment?.therapist_id || defaultTherapistId || null
  );
  const [roomId, setRoomId] = useState(appointment?.room_id || null);
  const [therapistRequested, setTherapistRequested] = useState(appointment?.therapist_requested || false);

  // Date + time stored separately for easy editing.
  // Always use LOCAL date/time components so BST (UTC+1) displays correctly.
  const initDate = appointment
    ? (() => { const d = new Date(appointment.starts_at); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; })()
    : (defaultDate || (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; })());

  const initTime = appointment
    ? (() => { const d = new Date(appointment.starts_at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; })()
    : (defaultStartsAt || '10:00');

  const [date, setDate]     = useState(initDate);
  const [time, setTime]     = useState(initTime);
  const [notes, setNotes]   = useState(appointment?.notes || '');
  const [status, setStatus] = useState(appointment?.status || 'booked');
  // SPA-SOURCE-DROPDOWN — booking reference. Drives the timeline colour.
  // Default 'phone' for new bookings (most common admin-created path).
  const [source, setSource] = useState(appointment?.source || 'phone');
  const [twType, setTwType] = useState(appointment?.treatwell_payment_type || 'partial');

  // Slot picker (for create mode convenience)
  const [slots, setSlots]   = useState([]);
  const [useSlotPicker, setUseSlotPicker] = useState(!isEdit);

  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [conflict, setConflict] = useState(null); // { conflicting, alternative_slots, alternative_therapists }

  // Rota state — drives the on-shift filter for the therapist dropdown.
  const [weeklyRota, setWeeklyRota]       = useState([]);
  const [rotaOverrides, setRotaOverrides] = useState([]);
  const [rotaMonth, setRotaMonth]         = useState(null);

  // ── Load reference data ───────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      api.get('/treatments'),
      api.get('/therapists'),
      api.get('/rooms'),
    ]).then(([t, th, r]) => {
      setTreatments(t.treatments || []);
      setTherapists(th.therapists || []);
      setRooms(r.rooms || []);
    });
    // In edit mode, load the client name for display
    if (appointment?.client_id) {
      api.get(`/clients/${appointment.client_id}`)
        .then(r => setClientName(r.client?.name || ''))
        .catch(() => {});
    }
  }, []);

  // ── Load rota for the selected month so the therapist dropdown can
  // filter to "actually on shift on this date". Reuses the same endpoint
  // and helpers as AppointmentScreen.
  useEffect(() => {
    if (!date) return;
    const m = date.slice(0, 7);
    if (m === rotaMonth) return;
    api.get(`/therapists/rota?month=${m}`)
      .then((r) => {
        setWeeklyRota(r.weekly_rota || []);
        setRotaOverrides(r.overrides || []);
        setRotaMonth(m);
      })
      .catch(() => {});
  }, [date, rotaMonth]);

  // ── Client search ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!clientQuery.trim()) { setClients([]); return; }
    const id = setTimeout(() => {
      api.get(`/clients?q=${encodeURIComponent(clientQuery)}`).then(r => setClients(r.clients || []));
    }, 250);
    return () => clearTimeout(id);
  }, [clientQuery]);

  // ── Slot picker (create mode) ─────────────────────────────────────────────
  useEffect(() => {
    if (!useSlotPicker || !treatmentId || !date) { setSlots([]); return; }
    const url = `/appointments/availability?treatment_id=${treatmentId}&date=${date}` +
                (therapistId ? `&therapist_id=${therapistId}` : '');
    api.get(url).then(r => setSlots(r.slots || [])).catch(() => setSlots([]));
  }, [useSlotPicker, treatmentId, date, therapistId]);

  // ── Submit ────────────────────────────────────────────────────────────────
  async function submit() {
    if (!treatmentId) { setError('Please choose a treatment.'); return; }
    if (!date || !time)  { setError('Please set a date and time.'); return; }

    setBusy(true); setError(''); setConflict(null);
    try {
      // Create new client if needed — sends the full intake body so the
      // appointment ties to a proper client record, not a name+phone stub.
      let useClientId = clientId;
      if (!useClientId && newClient.name.trim()) {
        const body = {
          name: newClient.name.trim(),
          phone:                   newClient.phone.trim() || null,
          email:                   newClient.email.trim() || null,
          date_of_birth:           newClient.date_of_birth || null,
          emergency_contact_name:  newClient.emergency_contact_name.trim() || null,
          emergency_contact_phone: newClient.emergency_contact_phone.trim() || null,
          gp_name:                 newClient.gp_name.trim() || null,
          gp_surgery:              newClient.gp_surgery.trim() || null,
          gdpr_consent:            !!newClient.gdpr_consent,
          marketing_consent:       !!newClient.marketing_consent,
          notes:                   newClient.notes.trim() || null,
        };
        const r = await api.post('/clients', body);
        useClientId = r.client.id;
      }

      // Build a proper UTC ISO string — treat date+time as LOCAL so BST is handled correctly
      const starts_at = new Date(`${date}T${time}:00`).toISOString();

      if (isEdit) {
        const body = {
          client_id:           useClientId || null,
          treatment_id:        Number(treatmentId),
          therapist_id:        therapistId ? Number(therapistId) : null,
          room_id:             roomId      ? Number(roomId)      : null,
          starts_at,
          notes:               notes || null,
          status,
          source,
          treatwell_payment_type: source === 'treatwell' ? twType : null,
          therapist_requested: therapistId ? therapistRequested : false,
        };
        const r = await api.put(`/appointments/${appointment.id}`, body);
        handleSaved(r.appointment);
      } else {
        const body = {
          client_id:           useClientId || null,
          treatment_id:        Number(treatmentId),
          therapist_id:        therapistId ? Number(therapistId) : null,
          room_id:             roomId      ? Number(roomId)      : null,
          starts_at,
          notes:               notes || null,
          source,
          treatwell_payment_type: source === 'treatwell' ? twType : null,
          therapist_requested: therapistId ? therapistRequested : false,
        };
        const r = await api.post('/appointments', body);
        handleSaved(r.appointment);
      }
    } catch (e) {
      if (e.status === 409 && (e.data?.conflicting || e.data?.rota_conflict)) {
        // Rich conflict — show alternatives panel instead of plain error
        setConflict(e.data);
      } else {
        setError(e.message || 'Failed to save');
      }
    } finally {
      setBusy(false);
    }
  }

  // Apply a suggested alternative slot
  function applySlot(iso) {
    const d = new Date(iso);
    // Use LOCAL date components so BST doesn't shift the date
    setDate(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
    setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    setConflict(null);
  }

  // Apply a suggested alternative therapist
  function applyTherapist(id, name) {
    setTherapistId(String(id));
    setConflict(null);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const selectedTreatment = treatments.find(t => String(t.id) === String(treatmentId));

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>{isEdit ? '✏️ Edit Appointment' : '📋 New Appointment'}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
        </div>

        {/* SPA-PAY-001 — deposit badge so the receptionist sees what the
            customer already paid online without opening the bill. */}
        {isEdit && Number(appointment?.deposit_amount) > 0 && (
          <div style={{
            background: '#dcfce7',
            border: '1px solid #86efac',
            color: '#166534',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 14,
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}>
            <span>
              💳 <strong>Deposit £{Number(appointment.deposit_amount).toFixed(2)} paid online</strong>
              {appointment.payment_status === 'refunded' && <span style={{ color: '#1e40af', marginLeft: 8 }}>· refunded</span>}
              {appointment.payment_status === 'forfeit'  && <span style={{ color: '#92400e', marginLeft: 8 }}>· forfeit</span>}
              {appointment.payment_status === 'fully_paid' && <span style={{ color: '#6b7280', marginLeft: 8 }}>· bill closed</span>}
            </span>
            {appointment.payment_status === 'deposit_paid' && (
              <span style={{ fontSize: 11, color: '#166534', whiteSpace: 'nowrap' }}>
                balance due at till
              </span>
            )}
          </div>
        )}

        {/* SPA-PAY-002 — payment-link generator. Shown when the booking
            exists but no deposit has been collected yet — e.g. taken
            over the phone. Receptionist gets a copy-able link to send
            via WhatsApp/SMS. */}
        {isEdit && appointment?.id && (!appointment.deposit_amount || appointment.payment_status === 'deposit_pending') && (
          <PaymentLinkBlock appointment={appointment} />
        )}

        {/* SPA-PAYMENT-EDIT — Amend the payment method on a closed bill.
            For "I tapped Cash but it was actually Card" mistakes. Only
            renders when the appointment is completed (i.e. the bill is
            closed). Admin/manager only — non-managers see a read-only
            label. */}
        {isEdit && appointment?.id && appointment.status === 'completed' && (
          <PaymentEditBlock appointment={appointment} onUpdated={(b) => {
            // Reflect the new method in the modal's view of the
            // appointment so a second edit reads the latest value.
            // (The timeline will pick it up via socket too.)
            if (appointment) appointment.payment_method = b.payment_method;
          }} />
        )}

        {/* SPA-TREATWELL-COLOR — for Treatwell bookings, let the
            receptionist flip between full-prepay and partial-deposit
            so the timeline colour is right. Webhook makes a best
            guess; this is the manual override. */}
        {isEdit && appointment?.source === 'treatwell' && (
          <TreatwellTypeBlock appointment={appointment} />
        )}

        <div className="col" style={{ gap: 14 }}>

          {/* ── Client ── */}
          <div>
            <label>Client</label>
            {clientId ? (
              <div className="row" style={{ justifyContent: 'space-between', background: 'var(--gold-light)', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(201,168,76,0.4)' }}>
                <span style={{ fontWeight: 600 }}>{clientName || `Client #${clientId}`}</span>
                <button style={{ fontSize: 12 }} onClick={() => { setClientId(null); setClientName(''); setClientQuery(''); }}>Change</button>
              </div>
            ) : (
              <>
                <input
                  placeholder="Search by name or phone…"
                  value={clientQuery}
                  onChange={e => setClientQuery(e.target.value)}
                />
                {clients.length > 0 && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 130, overflowY: 'auto', background: 'white', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                    {clients.map(c => (
                      <div key={c.id} onClick={() => { setClientId(c.id); setClientName(c.name); setClientQuery(''); setClients([]); }}
                        style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 14 }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-muted)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'white'}
                      >{c.name}{c.phone && <span className="muted"> · {c.phone}</span>}</div>
                    ))}
                  </div>
                )}
                <details
                  open={showNewClient || undefined}
                  onToggle={e => setShowNewClient(e.currentTarget.open)}
                  style={{ marginTop: 6 }}
                >
                  <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                    + New client / walk-in (full details)
                  </summary>
                  <div className="col" style={{ marginTop: 10, gap: 8, padding: 12, background: 'var(--gold-light, #fdf6e9)', border: '1px solid rgba(201,168,76,0.35)', borderRadius: 8 }}>
                    <div>
                      <label style={{ fontSize: 12 }}>Full name *</label>
                      <input value={newClient.name} onChange={e => setNew('name', e.target.value)} />
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12 }}>Phone</label>
                        <input type="tel" value={newClient.phone} onChange={e => setNew('phone', e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12 }}>Email</label>
                        <input type="email" value={newClient.email} onChange={e => setNew('email', e.target.value)} />
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: 12 }}>Date of birth</label>
                      <input type="date" value={newClient.date_of_birth} onChange={e => setNew('date_of_birth', e.target.value)} />
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12 }}>Emergency contact name</label>
                        <input value={newClient.emergency_contact_name} onChange={e => setNew('emergency_contact_name', e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12 }}>Emergency phone</label>
                        <input type="tel" value={newClient.emergency_contact_phone} onChange={e => setNew('emergency_contact_phone', e.target.value)} />
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12 }}>GP name</label>
                        <input value={newClient.gp_name} onChange={e => setNew('gp_name', e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12 }}>GP surgery</label>
                        <input value={newClient.gp_surgery} onChange={e => setNew('gp_surgery', e.target.value)} />
                      </div>
                    </div>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={!!newClient.gdpr_consent}
                        onChange={e => setNew('gdpr_consent', e.target.checked)}
                      />
                      <span>GDPR consent obtained (required to record medical data)</span>
                    </label>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={!!newClient.marketing_consent}
                        onChange={e => setNew('marketing_consent', e.target.checked)}
                      />
                      <span>Marketing email opt-in</span>
                    </label>
                    <div>
                      <label style={{ fontSize: 12 }}>Client notes (allergies, preferences…)</label>
                      <textarea rows={2} value={newClient.notes} onChange={e => setNew('notes', e.target.value)} />
                    </div>
                    <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
                      A new client record is created when you save this booking. Open their profile later to add a full medical questionnaire.
                    </div>
                  </div>
                </details>
              </>
            )}
          </div>

          {/* ── Treatment ── */}
          <div>
            <label>Treatment</label>
            <select value={treatmentId || ''} onChange={e => { setTreatmentId(e.target.value || null); setSlots([]); }}>
              <option value="">— Choose treatment —</option>
              {treatments.map(t => (
                <option key={t.id} value={t.id}>{t.name} · {t.duration_minutes}min · £{Number(t.price).toFixed(2)}</option>
              ))}
            </select>
          </div>

          {/* ── Therapist + Room ── */}
          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label>Therapist</label>
              {(() => {
                // Filter to (a) role='therapist' and (b) on-shift for the
                // selected date. The currently-selected therapist is kept
                // in the list as a one-off if they're off — so editing
                // legacy bookings doesn't blank the field.
                const onShift = therapists
                  .filter(t => t.role === 'therapist')
                  .filter(t => isWorkingOn(t.id, date, weeklyRota, rotaOverrides));
                const selectedTherapistId = therapistId ? Number(therapistId) : null;
                const selectedAlreadyIn = selectedTherapistId && onShift.some(t => t.id === selectedTherapistId);
                const selectedOff = selectedTherapistId && !selectedAlreadyIn
                  ? therapists.find(t => t.id === selectedTherapistId)
                  : null;
                return (
                  <select value={therapistId || ''} onChange={e => setTherapistId(e.target.value || null)}>
                    <option value="">Any available</option>
                    {onShift.map(t => {
                      const hours = workHoursOn(t.id, date, weeklyRota, rotaOverrides);
                      return (
                        <option key={t.id} value={t.id}>
                          {t.name}{hours ? ` · ${hours}` : ''}
                        </option>
                      );
                    })}
                    {selectedOff && (
                      <option key={selectedOff.id} value={selectedOff.id}>
                        {selectedOff.name} · (off this date)
                      </option>
                    )}
                  </select>
                );
              })()}
              {date && therapists.length > 0 && therapists.filter(t => t.role === 'therapist' && isWorkingOn(t.id, date, weeklyRota, rotaOverrides)).length === 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  No therapists on shift on this date.
                </div>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <label>Room</label>
              <select value={roomId || ''} onChange={e => setRoomId(e.target.value || null)}>
                <option value="">Auto-assign</option>
                {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>

          {/* ── Date + Time ── */}
          <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label>Date</label>
              <input type="date" value={date} onChange={e => { setDate(e.target.value); setSlots([]); }} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Start time</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} step={900} />
            </div>
            {selectedTreatment && (
              <div style={{ fontSize: 12, color: 'var(--muted)', paddingBottom: 6, whiteSpace: 'nowrap' }}>
                ends ~{(() => {
                  const [h, m] = time.split(':').map(Number);
                  const end = h * 60 + (m || 0) + selectedTreatment.duration_minutes;
                  return `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
                })()}
              </div>
            )}
          </div>

          {/* Slot picker toggle (create mode only) */}
          {!isEdit && treatmentId && (
            <div>
              <button
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => setUseSlotPicker(p => !p)}
              >{useSlotPicker ? '⬆ Hide slot picker' : '📅 Show available slots'}</button>
              {useSlotPicker && slots.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5, marginTop: 8, maxHeight: 120, overflowY: 'auto' }}>
                  {slots.map(s => {
                    const d = new Date(s.starts_at);
                    const label = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    const sel = time === label;
                    return (
                      <button key={s.starts_at} className={sel ? 'primary' : ''} style={{ padding: '6px 0', fontSize: 13 }}
                        onClick={() => setTime(label)}>{label}</button>
                    );
                  })}
                </div>
              )}
              {useSlotPicker && treatmentId && slots.length === 0 && (
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>No available slots for this date.</div>
              )}
            </div>
          )}

          {/* SPA-SOURCE-DROPDOWN — Booking reference / source. Drives
              the colour on the timeline. For Treatwell, a second
              toggle (Full / Partial) appears below. */}
          <div>
            <label>Booking source</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {[
                { id: 'phone',     label: '📞 Phone',    border: '#a855f7', bg: '#f3e8ff', text: '#6b21a8' },
                { id: 'walkin',    label: '🚶 Walk-in',  border: '#6366f1', bg: '#e0e7ff', text: '#3730a3' },
                { id: 'online',    label: '🪷 Online',   border: '#3b82f6', bg: '#dbeafe', text: '#1e40af' },
                { id: 'treatwell', label: '🌐 Treatwell', border: '#eab308', bg: '#fef9c3', text: '#854d0e' },
              ].map(s => {
                const active = source === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSource(s.id)}
                    style={{
                      flex: '1 1 100px',
                      padding: '8px 10px',
                      background: active ? s.border : s.bg,
                      color: active ? 'white' : s.text,
                      border: `2px solid ${s.border}`,
                      fontWeight: 700,
                      fontSize: 13,
                      borderRadius: 6,
                    }}
                  >{s.label}</button>
                );
              })}
            </div>
            {/* Treatwell sub-type — only shown when source=treatwell */}
            {source === 'treatwell' && (
              <div className="row" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Treatwell payment:</span>
                <button
                  type="button"
                  onClick={() => setTwType('full')}
                  style={{
                    flex: 1, fontSize: 12, padding: '5px 10px',
                    background: twType === 'full' ? '#16a34a' : 'white',
                    color:      twType === 'full' ? 'white'   : '#166534',
                    border: '1px solid #16a34a', fontWeight: 700,
                  }}
                >💚 Full prepay</button>
                <button
                  type="button"
                  onClick={() => setTwType('partial')}
                  style={{
                    flex: 1, fontSize: 12, padding: '5px 10px',
                    background: twType === 'partial' ? '#f59e0b' : 'white',
                    color:      twType === 'partial' ? 'white'   : '#92400e',
                    border: '1px solid #f59e0b', fontWeight: 700,
                  }}
                >🟡 Deposit only</button>
              </div>
            )}
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              The colour of this booking on the timeline depends on the source.
            </div>
          </div>

          {/* ── Status (edit only) — kept for completeness but the
              receptionist typically updates status via the timeline
              action buttons (Start / Checkout / Cancel), not here. */}
          {isEdit && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                Status: <strong style={{ color: '#1e3a6e' }}>{status.replace('_', ' ')}</strong> — change manually
              </summary>
              <select value={status} onChange={e => setStatus(e.target.value)} style={{ marginTop: 6 }}>
                {[...STATUSES, ...(STATUSES.includes(status) ? [] : [status])].map(s => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </select>
            </details>
          )}

          {/* ── Therapist requested ── */}
          {therapistId && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', padding: '6px 10px', background: therapistRequested ? 'rgba(201,168,76,0.12)' : '#f9fafb', borderRadius: 8, border: `1px solid ${therapistRequested ? '#C9A84C' : 'var(--border)'}` }}>
              <input type="checkbox" style={{ width: 'auto', accentColor: '#C9A84C' }} checked={therapistRequested} onChange={e => setTherapistRequested(e.target.checked)} />
              <span style={{ fontSize: 13 }}>⭐ Client specifically requested this therapist</span>
            </label>
          )}

          {/* ── Notes ── */}
          <div>
            <label>Notes (optional)</label>
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any special requests or notes…" />
          </div>

          {error && <div style={{ color: 'var(--danger)', fontSize: 13, background: '#fee2e2', padding: '8px 12px', borderRadius: 6 }}>{error}</div>}

          {/* ── Conflict panel ── (handles both time-conflict + rota-conflict) */}
          {conflict && (
            <div style={{ background: '#fff7ed', border: '2px solid #f97316', borderRadius: 10, overflow: 'hidden' }}>
              {/* Header — branches on the conflict variant */}
              <div style={{ background: '#f97316', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <div style={{ color: 'white', fontWeight: 700, fontSize: 14 }}>
                  {conflict.rota_conflict ? 'Therapist not on shift' : 'Time slot already booked'}
                </div>
              </div>
              <div style={{ padding: '12px 14px' }} className="col">
                {/* Body — rota-conflict variant */}
                {conflict.rota_conflict && (
                  <div style={{ fontSize: 13, color: '#92400e', background: '#fef3c7', borderRadius: 7, padding: '8px 12px', marginBottom: 10 }}>
                    {conflict.rota_conflict.working_window ? (
                      <>
                        <strong>{conflict.rota_conflict.therapist_name || 'This therapist'}</strong> only works{' '}
                        <strong>
                          {new Date(conflict.rota_conflict.working_window.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                          {' – '}
                          {new Date(conflict.rota_conflict.working_window.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </strong>{' '}
                        on this date. The chosen time is outside their rota.
                      </>
                    ) : (
                      <>
                        <strong>{conflict.rota_conflict.therapist_name || 'This therapist'}</strong> is <strong>off</strong> on this date.
                      </>
                    )}
                  </div>
                )}
                {/* Body — time-conflict variant */}
                {conflict.conflicting && (
                <div style={{ fontSize: 13, color: '#92400e', background: '#fef3c7', borderRadius: 7, padding: '8px 12px', marginBottom: 10 }}>
                  <strong>{conflict.conflicting.therapist_name || 'This therapist'}</strong> is booked{' '}
                  <strong>
                    {new Date(conflict.conflicting.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    {' – '}
                    {new Date(conflict.conflicting.ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </strong>
                  {conflict.conflicting.client_name && <> with <strong>{conflict.conflicting.client_name}</strong></>}
                  {conflict.conflicting.treatment_name && <> ({conflict.conflicting.treatment_name})</>}.
                </div>
                )}

                {/* Alternative time slots for same therapist */}
                {conflict.alternative_slots?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1e3a6e', marginBottom: 6 }}>
                      Next available times for {conflict.rota_conflict?.therapist_name || conflict.conflicting?.therapist_name || 'same therapist'}:
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {conflict.alternative_slots.map(s => {
                        const d = new Date(s.starts_at);
                        const isToday = d.toISOString().slice(0,10) === date;
                        const label = isToday
                          ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
                          : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                        return (
                          <button key={s.starts_at}
                            onClick={() => applySlot(s.starts_at)}
                            style={{ padding: '6px 12px', fontSize: 13, background: '#1e3a6e', color: 'white', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600 }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Alternative therapists free at requested time */}
                {conflict.alternative_therapists?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1e3a6e', marginBottom: 6 }}>
                      Free therapists at {time}:
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {conflict.alternative_therapists.map(t => (
                        <button key={t.id}
                          onClick={() => applyTherapist(t.id, t.name)}
                          style={{ padding: '6px 12px', fontSize: 13, background: '#16a34a', color: 'white', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600 }}>
                          👤 {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {conflict.alternative_slots?.length === 0 && conflict.alternative_therapists?.length === 0 && (
                  <div style={{ fontSize: 13, color: '#92400e' }}>No alternatives found for this date. Please choose a different day.</div>
                )}

                <button onClick={() => setConflict(null)} style={{ alignSelf: 'flex-end', marginTop: 6, fontSize: 12, background: 'transparent', border: '1px solid #f97316', color: '#c2410c', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Book appointment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
