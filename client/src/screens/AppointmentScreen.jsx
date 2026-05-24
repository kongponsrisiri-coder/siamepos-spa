import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { socket } from '../socket.js';
import NewAppointmentModal from '../components/NewAppointmentModal.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function isWorkingOn(therapistId, dateStr, weeklyRota, overrides) {
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
  const override = overrides.find(o => o.therapist_id === therapistId && o.date?.slice(0, 10) === dateStr);
  if (override) return Boolean(override.is_working);
  const entry = weeklyRota.find(r => r.therapist_id === therapistId && r.day_of_week === dayOfWeek);
  if (entry) return true;
  const hasAnyRota = weeklyRota.some(r => r.therapist_id === therapistId);
  return !hasAnyRota;
}

function getWorkHours(therapistId, dateStr, weeklyRota, overrides) {
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();
  const override = overrides.find(o => o.therapist_id === therapistId && o.date?.slice(0, 10) === dateStr);
  if (override && override.is_working && override.start_time && override.end_time) {
    return { start: String(override.start_time).slice(0, 5), end: String(override.end_time).slice(0, 5) };
  }
  const entry = weeklyRota.find(r => r.therapist_id === therapistId && r.day_of_week === dayOfWeek);
  if (entry && entry.start_time && entry.end_time) {
    return { start: String(entry.start_time).slice(0, 5), end: String(entry.end_time).slice(0, 5) };
  }
  return null;
}

const PAYMENT_COLOR = {
  cash:      '#f97316',
  card:      '#ec4899',
  voucher:   '#16a34a',
  treatwell: '#eab308',
  split:     '#7c3aed',
  other:     '#6b7280',
};
function pmColor(method) { return PAYMENT_COLOR[method] || PAYMENT_COLOR.other; }
function pmLabel(method) { return method ? method.charAt(0).toUpperCase() + method.slice(1) : ''; }

// ── Timeline constants ────────────────────────────────────────────────────────
const COL_W      = 154;   // desktop column width
const COL_W_MOB  = 110;   // mobile column width — fits ~3 on a 375px phone
const LBL_W      = 52;    // desktop time-label width
const LBL_W_MOB  = 42;    // mobile time-label width
const DAY_START  = 9;
// Extended to 22 so the 20:00 row has visual breathing room — operators
// couldn't see the bottom of the 20:00 slot when the grid ended at 21.
const DAY_END    = 22;
const NUM_HOURS  = DAY_END - DAY_START;
const HEADER_H   = 52;

// SPA-SOURCE-COLOR — colour the appointment block by where the booking
// came from, NOT by status. Spa wanted "phone / online / Treatwell" at a
// glance. Treatwell split into full-prepay vs partial since that drives
// whether the till collects anything.
//
//   walkin/staff = in-person or staff-created (phone bookings live here
//                  currently — no separate 'phone' source in the schema)
//   online        = website widget
//   treatwell·full    = customer prepaid in full to Treatwell
//   treatwell·partial = customer paid a deposit; balance due at till
// Colour the appointment block by its **booking source** while it's
// still scheduled. Once it COMPLETES, switch to the payment-method
// colour so the receptionist can see at a glance how each customer
// settled the bill.
const SOURCE_STYLE = {
  phone:            { bg: '#f3e8ff', border: '#a855f7', text: '#6b21a8' },  // PURPLE — phone (changed from teal: too similar to treatwell-full's green)
  walkin:           { bg: '#e0e7ff', border: '#6366f1', text: '#3730a3' },  // indigo — in-store
  staff:            { bg: '#e0e7ff', border: '#6366f1', text: '#3730a3' },  // indigo — staff-created
  online:           { bg: '#f5e6d3', border: '#8b4513', text: '#5a3a1f' },  // brown — widget (was blue, too similar to walkin indigo)
  treatwell_full:   { bg: '#dcfce7', border: '#16a34a', text: '#14532d' },  // green — Treatwell prepaid in full
  treatwell_partial:{ bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },  // amber — Treatwell partial deposit
  cancelled:        { bg: '#f3f4f6', border: '#9ca3af', text: '#9ca3af' },  // grey — used by apptStyle, not in legend
  no_show:          { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },  // red  — used by apptStyle, not in legend
};
const PAYMENT_STYLE = {
  cash:      { bg: '#ffedd5', border: '#f97316', text: '#9a3412' },  // orange
  card:      { bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },  // pink
  voucher:   { bg: '#d1fae5', border: '#10b981', text: '#065f46' },  // emerald — distinct from treatwell-full's green
  treatwell: { bg: '#fef9c3', border: '#eab308', text: '#854d0e' },  // yellow
  split:     { bg: '#ede9fe', border: '#7c3aed', text: '#4c1d95' },  // violet
};
function apptStyle(a) {
  if (a.status === 'cancelled') return SOURCE_STYLE.cancelled;
  if (a.status === 'no_show')   return SOURCE_STYLE.no_show;
  if (a.status === 'completed' && a.payment_method) {
    return PAYMENT_STYLE[a.payment_method] || PAYMENT_STYLE.split;
  }
  if (a.source === 'treatwell') {
    return SOURCE_STYLE[a.treatwell_payment_type === 'full' ? 'treatwell_full' : 'treatwell_partial'];
  }
  return SOURCE_STYLE[a.source] || SOURCE_STYLE.walkin;
}
const COL_COLORS = ['#0D1B3E','#1A2F6B','#071028','#0f2456','#162e5c','#0e2260'];

function toLocalMins(iso) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }

// ── Mobile action sheet ───────────────────────────────────────────────────────
// Slides up from bottom when owner taps an appointment on their phone.
// Shows full details + tap-to-call + action buttons.
function MobileActionSheet({ appt, onClose, onEdit, onStatus, onCheckout }) {
  const s = apptStyle(appt);
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 150,
          background: 'rgba(13,27,62,0.5)',
          backdropFilter: 'blur(3px)',
          WebkitBackdropFilter: 'blur(3px)',
        }}
      />
      {/* Sheet */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 151,
        background: 'white',
        borderRadius: '18px 18px 0 0',
        padding: '12px 20px',
        paddingBottom: 'calc(80px + env(safe-area-inset-bottom, 0px))',
        boxShadow: '0 -8px 40px rgba(13,27,62,0.22)',
        animation: 'slideUp 0.22s ease',
      }}>
        {/* Drag handle */}
        <div style={{ width: 36, height: 4, background: '#d1d5db', borderRadius: 2, margin: '0 auto 16px' }} />

        {/* Status + time */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span className={`status-pill status-${appt.status}`}>{appt.status.replace('_', ' ')}</span>
          <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}>
            {fmtTime(appt.starts_at)} – {fmtTime(appt.ends_at)}
          </span>
        </div>

        {/* Client name */}
        <div style={{ fontSize: 22, fontWeight: 800, color: '#0D1B3E', marginBottom: 4, lineHeight: 1.2 }}>
          {appt.client_name || 'Walk-in'}
        </div>

        {/* Treatment */}
        <div style={{ fontSize: 15, color: '#374151', marginBottom: 6, fontWeight: 500 }}>
          {appt.treatment_name || '—'}
        </div>

        {/* Therapist + room */}
        {(appt.therapist_name || appt.room_name) && (
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {appt.therapist_name && <span>👤 {appt.therapist_name}</span>}
            {appt.room_name      && <span>🚪 {appt.room_name}</span>}
          </div>
        )}

        {/* Tap-to-call — the #1 thing an owner needs on their phone */}
        {appt.client_phone && (
          <a
            href={`tel:${appt.client_phone}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: '#f0fdf4', color: '#16a34a',
              border: '1px solid #bbf7d0', borderRadius: 12,
              padding: '12px 16px', textDecoration: 'none',
              fontWeight: 700, fontSize: 16, marginBottom: 16,
              WebkitTapHighlightColor: 'transparent',
            }}>
            <span style={{ fontSize: 20 }}>📞</span>
            {appt.client_phone}
          </a>
        )}

        {/* Payment badge if paid */}
        {appt.payment_method && (
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Paid by</span>
            <span style={{
              background: pmColor(appt.payment_method), color: 'white',
              fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
            }}>{pmLabel(appt.payment_method)}</span>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => { onEdit(appt); onClose(); }}
            style={{ flex: 1, minWidth: 80, minHeight: 52, borderRadius: 12, border: '1px solid var(--border)', background: 'white', fontWeight: 600, fontSize: 14, color: '#374151' }}>
            ✏️ Edit
          </button>

          {appt.status === 'booked' && (
            <>
              <button
                onClick={() => { onStatus(appt.id, 'in_progress'); onClose(); }}
                style={{ flex: 1, minWidth: 80, minHeight: 52, borderRadius: 12, background: '#22c55e', color: 'white', border: 'none', fontWeight: 700, fontSize: 14 }}>
                ▶ Start
              </button>
              <button
                onClick={() => { onCheckout(appt); onClose(); }}
                style={{ flex: 1, minWidth: 80, minHeight: 52, borderRadius: 12, background: '#0D1B3E', color: 'white', border: 'none', fontWeight: 700, fontSize: 14 }}>
                🧾 Pay
              </button>
              <button
                onClick={() => { onStatus(appt.id, 'cancelled'); onClose(); }}
                style={{ flex: 1, minWidth: 80, minHeight: 52, borderRadius: 12, background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5', fontWeight: 600, fontSize: 14 }}>
                ✕ Cancel
              </button>
            </>
          )}

          {appt.status === 'in_progress' && (
            <button
              onClick={() => { onCheckout(appt); onClose(); }}
              style={{ flex: 2, minHeight: 52, borderRadius: 12, background: '#C9A84C', color: '#0D1B3E', border: 'none', fontWeight: 800, fontSize: 17 }}>
              🧾 Checkout
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// VERTICAL TIMELINE
// ══════════════════════════════════════════════════════════════════════════════
function TimelineView({ appointments, therapistColumns, workingTherapists, selected, onSelect, onSlotClick, onEditClick, onColumnReorder, isMobile }) {
  const nowRef       = useRef(null);
  const containerRef = useRef(null);
  const [containerH, setContainerH] = useState(0);
  const [dragSrc,  setDragSrc]  = useState(null);
  const [dragOver, setDragOver] = useState(null);

  // Responsive dimensions
  const COL_W_USE = isMobile ? COL_W_MOB : COL_W;
  const LBL_W_USE = isMobile ? LBL_W_MOB : LBL_W;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setContainerH(entries[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // On mobile use a comfortable fixed height per hour so the day is readable.
  // On desktop adapt to fill the screen.
  const gridH   = containerH > 100 ? containerH - HEADER_H - (isMobile ? 0 : 34) : NUM_HOURS * 64;
  const HOUR_H  = isMobile ? 64 : Math.floor(gridH / NUM_HOURS);
  const totalH  = HOUR_H * NUM_HOURS;

  function minsToPx(mins) { return ((mins - DAY_START * 60) / 60) * HOUR_H; }

  const hours = Array.from({ length: NUM_HOURS + 1 }, (_, i) => DAY_START + i);

  const visibleAppts = appointments.filter(a => !['cancelled', 'no_show'].includes(a.status));

  const apptMap = {};
  visibleAppts.forEach(a => {
    const key = a.therapist_id || 0;
    if (!apptMap[key]) apptMap[key] = [];
    apptMap[key].push(a);
  });

  let columns;
  const sourceList = therapistColumns && therapistColumns.length > 0
    ? therapistColumns
    : workingTherapists && workingTherapists.length > 0
      ? workingTherapists
      : null;
  if (sourceList) {
    // Parent already applied the turn order / drag override; preserve
    // it verbatim — DO NOT alphabetically re-sort here.
    columns = sourceList.map(t => ({ id: t.id, name: t.name, isOff: !!t.isOff, workStart: t.workStart || null, workEnd: t.workEnd || null, isOverride: !!t.isOverride, appts: apptMap[t.id] || [] }));
    Object.keys(apptMap).forEach(tid => {
      const id = Number(tid);
      if (!columns.find(c => c.id === id)) {
        const name = visibleAppts.find(a => a.therapist_id === id)?.therapist_name || 'Unassigned';
        columns.push({ id, name, isOff: false, appts: apptMap[tid] });
      }
    });
  } else {
    // Fallback path — columns derived from the appointment list only
    // (no rota loaded). Alphabetical is sensible here.
    const map = {};
    visibleAppts.forEach(a => {
      const key = a.therapist_id || 0;
      if (!map[key]) map[key] = { id: key, name: a.therapist_name || 'Unassigned', appts: [] };
      map[key].appts.push(a);
    });
    columns = Object.values(map);
    columns.sort((a, b) => a.name.localeCompare(b.name));
  }

  const now     = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const showNow = nowMins >= DAY_START * 60 && nowMins <= DAY_END * 60;

  useEffect(() => {
    if (nowRef.current) nowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  if (!columns.length) return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <div className="muted">No therapists are scheduled to work on this day.</div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1, minHeight: 0,
        overflowX: 'auto',
        // On mobile allow vertical scroll so the owner can scroll through time.
        // On desktop keep overflow hidden — the whole day is visible at once.
        // Allow scroll on every device so the full grid (incl. the
        // bottom 20:00–22:00 area) is reachable even on short screens.
        overflowY: 'auto',
        border: '1px solid var(--border)', borderRadius: 10,
        display: 'flex', flexDirection: 'column',
        // Mobile: let height be natural (scrollable). Desktop: fills container.
        ...(isMobile ? { height: 'auto', maxHeight: 'none' } : {}),
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <div style={{ minWidth: LBL_W_USE + columns.length * COL_W_USE, flex: isMobile ? 'none' : 1, position: 'relative', overflowY: 'hidden' }}>

        {/* ── Sticky header ── */}
        <div style={{
          display: 'flex', position: 'sticky', top: 0, zIndex: 20,
          background: '#0D1B3E', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}>
          <div style={{ width: LBL_W_USE, flexShrink: 0 }} />
          {columns.map((col, ci) => {
            const activeAppts = col.appts.filter(a => !['cancelled','no_show'].includes(a.status));
            const workedMins  = activeAppts.reduce((sum, a) =>
              sum + (new Date(a.ends_at) - new Date(a.starts_at)) / 60000, 0);
            const workedLabel = workedMins >= 60
              ? `${Math.floor(workedMins / 60)}h${workedMins % 60 ? ` ${workedMins % 60}m` : ''}`
              : workedMins > 0 ? `${workedMins}m` : '';
            const isDragTarget = dragOver === ci && dragSrc !== null && dragSrc !== ci;
            return (
              <div key={col.id}
                draggable={!isMobile}
                onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragSrc(ci); }}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(ci); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => {
                  e.preventDefault();
                  if (dragSrc !== null && dragSrc !== ci) onColumnReorder?.(dragSrc, ci);
                  setDragSrc(null); setDragOver(null);
                }}
                onDragEnd={() => { setDragSrc(null); setDragOver(null); }}
                style={{
                  width: COL_W_USE, flexShrink: 0,
                  padding: isMobile ? '7px 4px' : '8px 8px',
                  textAlign: 'center',
                  borderLeft: isDragTarget ? '2px solid #C9A84C' : '1px solid rgba(255,255,255,0.18)',
                  opacity: col.isOff ? 0.55 : dragSrc === ci ? 0.4 : 1,
                  cursor: isMobile ? 'default' : 'grab',
                  background: isDragTarget ? 'rgba(201,168,76,0.2)' : 'transparent',
                  transition: 'background 0.1s, border-color 0.1s',
                  userSelect: 'none',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                  {!isMobile && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '-1px' }}>⠿</span>}
                  {/* First name only on mobile to save space */}
                  <span style={{ fontWeight: 800, fontSize: isMobile ? 12 : 14, color: col.isOff ? 'rgba(255,255,255,0.5)' : 'white', letterSpacing: '0.01em' }}>
                    {isMobile ? col.name.split(' ')[0] : col.name}
                  </span>
                </div>
                <div style={{ fontSize: 10, marginTop: 1, color: col.isOff ? 'rgba(255,200,100,0.55)' : '#f5c07a' }}>
                  {col.isOff ? 'Off' : activeAppts.length === 0 ? 'free' : `${activeAppts.length}✓`}
                </div>
                {/* Working window — shown when the column has explicit
                    hours (rota or override). Gold star prefix flags an
                    override so the receptionist knows it's special for
                    today, not the normal shift. */}
                {!col.isOff && col.workStart && col.workEnd && (
                  <div style={{ fontSize: 10, marginTop: 2, color: col.isOverride ? '#C9A84C' : 'rgba(255,255,255,0.55)', fontWeight: col.isOverride ? 700 : 400 }}>
                    {col.isOverride ? '★ ' : ''}{col.workStart}–{col.workEnd}
                  </div>
                )}
                {!isMobile && !col.isOff && workedLabel && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>{workedLabel} booked</div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Grid ── */}
        <div style={{ display: 'flex', position: 'relative' }}>

          {/* Time axis */}
          <div style={{
            width: LBL_W_USE, flexShrink: 0,
            position: 'sticky', left: 0, zIndex: 10, background: 'white',
          }}>
            {hours.map(h => (
              <div key={h} style={{ height: HOUR_H, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', paddingTop: 5, paddingRight: 6, justifyContent: 'flex-end' }}>
                <span style={{ fontSize: isMobile ? 10 : 11, fontWeight: 600, color: 'var(--muted)' }}>{pad(h)}:00</span>
              </div>
            ))}
          </div>

          {/* Therapist columns */}
          {columns.map((col, ci) => {
            let blockedBands = [];
            if (!col.isOff && col.workStart && col.workEnd) {
              const [wsh, wsm] = col.workStart.split(':').map(Number);
              const [weh, wem] = col.workEnd.split(':').map(Number);
              const workStartMins = wsh * 60 + wsm;
              const workEndMins   = weh * 60 + wem;
              if (workStartMins > DAY_START * 60) {
                blockedBands.push({ top: 0, height: minsToPx(workStartMins), borderSide: 'bottom' });
              }
              if (workEndMins < DAY_END * 60) {
                blockedBands.push({ top: minsToPx(workEndMins), height: totalH - minsToPx(workEndMins), borderSide: 'top' });
              }
            }

            return (
              <div key={col.id}
                style={{
                  width: COL_W_USE, flexShrink: 0, position: 'relative', height: totalH,
                  borderLeft: '1px solid var(--border)',
                  cursor: col.isOff ? 'default' : 'crosshair',
                  background: col.isOff
                    ? 'repeating-linear-gradient(135deg, #f5f5f5 0px, #f5f5f5 8px, #ececec 8px, #ececec 16px)'
                    : 'white',
                }}
                onClick={col.isOff ? undefined : e => {
                  if (e.target !== e.currentTarget) return;
                  if (!onSlotClick) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickY = e.clientY - rect.top;
                  const rawMins = (clickY / HOUR_H) * 60 + DAY_START * 60;
                  const mins = Math.round(rawMins / 15) * 15;
                  if (col.workStart && col.workEnd) {
                    const [wsh, wsm] = col.workStart.split(':').map(Number);
                    const [weh, wem] = col.workEnd.split(':').map(Number);
                    if (mins < wsh * 60 + wsm || mins >= weh * 60 + wem) return;
                  }
                  const h = Math.floor(mins / 60);
                  const m = mins % 60;
                  onSlotClick({ therapistId: col.id, therapistName: col.name, time: `${pad(h)}:${pad(m)}` });
                }}
              >
                {/* Grid lines */}
                {hours.map(h => (
                  <div key={h} style={{ position: 'absolute', top: (h - DAY_START) * HOUR_H, left: 0, right: 0, height: HOUR_H, borderBottom: '1px solid #f3f4f6', pointerEvents: 'none' }}>
                    <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: '#fafafa' }} />
                  </div>
                ))}

                {/* Blocked-hours overlay */}
                {blockedBands.map((band, bi) => (
                  <div key={bi} style={{
                    position: 'absolute', top: band.top, left: 0, right: 0, height: band.height,
                    background: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.035) 0px, rgba(0,0,0,0.035) 7px, transparent 7px, transparent 14px)',
                    borderTop: band.borderSide === 'top' ? '1.5px dashed #d1d5db' : 'none',
                    borderBottom: band.borderSide === 'bottom' ? '1.5px dashed #d1d5db' : 'none',
                    pointerEvents: 'none', zIndex: 2,
                  }} />
                ))}

                {/* Appointment blocks */}
                {col.appts.map(a => {
                  const startM = toLocalMins(a.starts_at);
                  const endM   = toLocalMins(a.ends_at);
                  const top    = minsToPx(startM);
                  const height = Math.max(minsToPx(endM) - minsToPx(startM) - 2, 26);
                  const isSel  = selected?.id === a.id;
                  const s      = apptStyle(a);
                  const hasPm  = Boolean(a.payment_method);
                  const isReq  = Boolean(a.therapist_requested);
                  return (
                    <div key={a.id}
                      onClick={e => { e.stopPropagation(); onSelect(isSel ? null : a); }}
                      onDoubleClick={e => { e.stopPropagation(); !isMobile && onEditClick && onEditClick(a); }}
                      style={{
                        position: 'absolute', left: 3, right: 3, top, height,
                        borderRadius: isMobile ? 6 : 7, cursor: 'pointer',
                        background: isSel ? COL_COLORS[ci % COL_COLORS.length] : s.bg,
                        border: `2px solid ${isSel ? COL_COLORS[ci % COL_COLORS.length] : s.border}`,
                        padding: '3px 5px', overflow: 'hidden',
                        boxShadow: isSel ? '0 4px 14px rgba(0,0,0,0.22)' : '0 1px 3px rgba(0,0,0,0.07)',
                        zIndex: isSel ? 8 : 4, transition: 'all 0.12s',
                        WebkitTapHighlightColor: 'transparent',
                        touchAction: 'manipulation',
                      }}>
                      {/* Client name */}
                      <div style={{ fontSize: isMobile ? 11 : 12, fontWeight: 700, color: isSel ? 'white' : s.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3 }}>
                        {isReq && <span style={{ marginRight: 2, fontSize: 9 }}>⭐</span>}
                        {a.client_name || 'Walk-in'}
                      </div>
                      {/* Treatment — show if enough vertical space */}
                      {height > 36 && (
                        <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.85)' : s.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.9, lineHeight: 1.3 }}>
                          {a.treatment_name}
                        </div>
                      )}
                      {/* Time — only on desktop or taller blocks */}
                      {!isMobile && height > 54 && (
                        <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.7)' : s.text, opacity: 0.75 }}>
                          {fmtTime(a.starts_at)} – {fmtTime(a.ends_at)}
                        </div>
                      )}
                      {!isMobile && height > 68 && a.room_name && (
                        <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.65)' : s.text, opacity: 0.7 }}>
                          🚪 {a.room_name}
                        </div>
                      )}
                      {/* Payment badge */}
                      {hasPm && height > 46 && (
                        <div style={{
                          position: 'absolute', bottom: 3, right: 4,
                          fontSize: 9, fontWeight: 700, lineHeight: 1,
                          background: isSel ? 'rgba(255,255,255,0.25)' : pmColor(a.payment_method),
                          color: 'white', padding: '2px 4px', borderRadius: 3,
                        }}>
                          {pmLabel(a.payment_method)}
                        </div>
                      )}
                      {/* Desktop edit hint */}
                      {!isMobile && isSel && height > 46 && (
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.65)', marginTop: 2 }}>✏ dbl-click to edit</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Now line */}
          {showNow && (
            <div ref={nowRef} style={{ position: 'absolute', left: 0, right: 0, top: minsToPx(nowMins), zIndex: 15, pointerEvents: 'none', display: 'flex', alignItems: 'center' }}>
              <div style={{ width: LBL_W_USE, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', paddingRight: 4 }}>
                <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 700 }}>{pad(now.getHours())}:{pad(now.getMinutes())}</span>
              </div>
              <div style={{ flex: 1, height: 2, background: '#ef4444', opacity: 0.75 }} />
            </div>
          )}
        </div>
      </div>

      {/* Legend — desktop only. Two groups: booking source (used while
          the appointment is still booked / in-progress) and payment
          method (used once it's completed). */}
      {!isMobile && (
        <div style={{ padding: '8px 12px', background: '#fafafa', borderTop: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Source</span>
          {[
            { palette: SOURCE_STYLE, key: 'phone',             label: '📞 Phone' },
            { palette: SOURCE_STYLE, key: 'walkin',            label: '🚶 Walk-in' },
            { palette: SOURCE_STYLE, key: 'online',            label: '🪷 Online' },
            { palette: SOURCE_STYLE, key: 'treatwell_full',    label: '🌐 Treatwell · prepaid' },
            { palette: SOURCE_STYLE, key: 'treatwell_partial', label: '🌐 Treatwell · deposit' },
          ].map(({ palette, key, label }) => {
            const s = palette[key];
            return (
              <span key={key} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.bg, border: `2px solid ${s.border}`, display: 'inline-block' }} />
                <span style={{ color: 'var(--muted)' }}>{label}</span>
              </span>
            );
          })}
          <span style={{ width: 1, height: 14, background: 'var(--border)', display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Paid by</span>
          {[
            { key: 'cash',      label: '💵 Cash' },
            { key: 'card',      label: '💳 Card' },
            { key: 'voucher',   label: '🎁 Voucher' },
            { key: 'treatwell', label: '🌐 Treatwell' },
            { key: 'split',     label: '⇄ Split' },
          ].map(({ key, label }) => {
            const s = PAYMENT_STYLE[key];
            return (
              <span key={key} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.bg, border: `2px solid ${s.border}`, display: 'inline-block' }} />
                <span style={{ color: 'var(--muted)' }}>{label}</span>
              </span>
            );
          })}
          <span style={{ width: 1, height: 14, background: 'var(--border)', display: 'inline-block' }} />
          <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10 }}>⭐</span> Therapist requested
          </span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ══════════════════════════════════════════════════════════════════════════════
export default function AppointmentScreen() {
  const [date, setDate]               = useState(todayISO);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [view, setView]               = useState('timeline');
  const [selected, setSelected]       = useState(null);
  const [modal, setModal]             = useState(null);
  const [allTherapists, setAllTherapists] = useState([]);
  const [weeklyRota, setWeeklyRota]       = useState([]);
  const [rotaOverrides, setRotaOverrides] = useState([]);
  const [rotaMonth, setRotaMonth]         = useState('');
  const [columnOrder, setColumnOrder]     = useState(null);
  const [turnOrder,    setTurnOrder]      = useState([]);   // SPA-TURN-ORDER — backend-saved order
  const [showTurnModal, setShowTurnModal] = useState(false);

  // Responsive breakpoint — drives column widths + action sheet vs action bar
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const navigate = useNavigate();

  const month = date.slice(0, 7);
  const refreshRota = useCallback(async (m) => {
    try {
      const r = await api.get(`/therapists/rota?month=${m}`);
      setAllTherapists(r.therapists || []);
      setWeeklyRota(r.weekly_rota || []);
      setRotaOverrides(r.overrides || []);
      setTurnOrder(r.turn_order || []);
      setRotaMonth(m);
    } catch { /* fall back to appointment-derived columns */ }
  }, []);

  useEffect(() => {
    if (month !== rotaMonth) refreshRota(month);
  }, [month, rotaMonth, refreshRota]);

  useEffect(() => {
    const onRotaUpdated = () => refreshRota(month);
    socket.on('rota_updated', onRotaUpdated);
    socket.on('turn_order_updated', onRotaUpdated);
    return () => {
      socket.off('rota_updated', onRotaUpdated);
      socket.off('turn_order_updated', onRotaUpdated);
    };
  }, [month, refreshRota]);

  useEffect(() => {
    const saved = localStorage.getItem(`spa_col_order_${date}`);
    setColumnOrder(saved ? JSON.parse(saved) : null);
  }, [date]);

  const therapistColumns = allTherapists
    .filter(t => t.role === 'therapist')
    .map(t => {
      const isOff = !isWorkingOn(t.id, date, weeklyRota, rotaOverrides);
      const hours = isOff ? null : getWorkHours(t.id, date, weeklyRota, rotaOverrides);
      // Is this hour window coming from an override (vs the weekly rota)?
      // Used in the column header to flag "today is custom" with a gold star.
      const hasOverride = !!rotaOverrides.find(o => o.therapist_id === t.id && String(o.date).slice(0, 10) === date);
      return { ...t, isOff, workStart: hours?.start || null, workEnd: hours?.end || null, isOverride: hasOverride };
    });

  // SPA-TURN-ORDER — backend-saved order for THIS DATE.
  const turnOrderToday = turnOrder
    .filter(r => String(r.date).slice(0, 10) === date)
    .sort((a, b) => a.position - b.position)
    .map(r => r.therapist_id);

  // Sort priority: 1) per-tablet drag override (localStorage) wins,
  // 2) then the backend-saved turn order for the day, 3) otherwise
  // alphabetical (the natural order from the rota endpoint).
  const orderedTherapistColumns = (columnOrder || turnOrderToday.length > 0)
    ? [...therapistColumns].sort((a, b) => {
        const list = columnOrder && columnOrder.length > 0 ? columnOrder : turnOrderToday;
        const ai = list.indexOf(a.id);
        const bi = list.indexOf(b.id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      })
    : therapistColumns;

  function handleColumnReorder(fromIdx, toIdx) {
    const ids = orderedTherapistColumns.map(t => t.id);
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, moved);
    setColumnOrder(ids);
    localStorage.setItem(`spa_col_order_${date}`, JSON.stringify(ids));
  }

  function resetColumnOrder() {
    setColumnOrder(null);
    localStorage.removeItem(`spa_col_order_${date}`);
  }

  const workingTherapists = orderedTherapistColumns.filter(t => !t.isOff);

  const load = useCallback(async () => {
    setLoading(true);
    setSelected(null);
    try {
      const r = await api.get(`/appointments?date=${date}`);
      setAppointments(r.appointments || []);
    } finally { setLoading(false); }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const refresh = () => load();
    socket.on('new_appointment',     refresh);
    socket.on('appointment_updated', refresh);
    socket.on('appointment_status',  refresh);
    return () => {
      socket.off('new_appointment',     refresh);
      socket.off('appointment_updated', refresh);
      socket.off('appointment_status',  refresh);
    };
  }, [load]);

  async function setStatus(id, status) {
    try { await api.put(`/appointments/${id}/status`, { status }); load(); }
    catch (e) { alert(e.message); }
  }

  async function startCheckout(appt) {
    try {
      await api.post('/bills', { appointment_id: appt.id });
      navigate(`/checkout/${appt.id}`);
    } catch (e) { alert(e.message); }
  }

  function shiftDay(delta) {
    const d = new Date(date + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    setDate(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
  }

  const friendlyDate = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const grouped = {
    in_progress: appointments.filter(a => a.status === 'in_progress'),
    booked:      appointments.filter(a => a.status === 'booked'),
    completed:   appointments.filter(a => a.status === 'completed'),
    other:       appointments.filter(a => ['cancelled','no_show'].includes(a.status)),
  };

  // Height of the outer column:
  // Desktop: viewport minus topnav (52) and internal padding/controls (~97px total legacy)
  // Mobile:  viewport minus topnav (52) + bottom-nav (60) + padding-top (16) + buffer (40)
  //          The CSS app-main padding-bottom already reserves the bottom-nav space,
  //          so the available height shrinks accordingly. Use dvh for iOS accuracy.
  const outerH = isMobile
    ? 'calc(100dvh - 168px)'   // 52(nav) + 60(bottom-nav) + 16(pad-top) + 40(controls+buffer)
    : 'calc(100vh - 97px)';    // desktop: unchanged

  return (
    <div className="col" style={{ height: outerH, overflow: 'hidden', gap: 8 }}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      {isMobile ? (
        // Mobile: two compact rows
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          {/* Row 1: date navigation — big and easy to tap */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => shiftDay(-1)} style={{ minHeight: 44, padding: '0 16px', fontSize: 20, lineHeight: 1 }}>‹</button>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{friendlyDate}</div>
              {date !== todayISO() && (
                <button onClick={() => setDate(todayISO())} style={{ fontSize: 11, padding: '2px 10px', marginTop: 2, minHeight: 'auto', border: '1px solid var(--gold)', color: 'var(--gold)', background: 'transparent', borderRadius: 4 }}>
                  Today
                </button>
              )}
            </div>
            <button onClick={() => shiftDay(1)}  style={{ minHeight: 44, padding: '0 16px', fontSize: 20, lineHeight: 1 }}>›</button>
          </div>
          {/* Row 2: view toggle + new appointment */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={view === 'timeline' ? 'primary' : ''}
              onClick={() => setView('timeline')}
              style={{ flex: 1, minHeight: 44, fontSize: 13 }}>
              ⏱ Timeline
            </button>
            <button
              className={view === 'list' ? 'primary' : ''}
              onClick={() => setView('list')}
              style={{ flex: 1, minHeight: 44, fontSize: 13 }}>
              ☰ List
            </button>
            <button
              className="gold"
              onClick={() => setModal({})}
              style={{ flex: 1, minHeight: 44, fontSize: 14, fontWeight: 700 }}>
              + New
            </button>
          </div>
        </div>
      ) : (
        // Desktop: single row (unchanged)
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, flexShrink: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <button onClick={() => shiftDay(-1)} style={{ padding: '7px 12px' }}>‹</button>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: 150 }} />
            <span style={{ fontSize: 14, color: 'var(--muted)', alignSelf: 'center', minWidth: 90 }}>{friendlyDate}</span>
            <button onClick={() => shiftDay(1)} style={{ padding: '7px 12px' }}>›</button>
            {date !== todayISO() && <button onClick={() => setDate(todayISO())} style={{ fontSize: 13 }}>Today</button>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className={view === 'timeline' ? 'primary' : ''} onClick={() => setView('timeline')} style={{ fontSize: 13 }}>⏱ Timeline</button>
            <button className={view === 'list'     ? 'primary' : ''} onClick={() => setView('list')}     style={{ fontSize: 13 }}>☰ List</button>
            {view === 'timeline' && (
              <button onClick={() => setShowTurnModal(true)} style={{ fontSize: 13 }} title="Set today's column order">🔢 Set turn order</button>
            )}
            <button className="primary" onClick={() => setModal({})}>+ New</button>
          </div>
        </div>
      )}

      {loading && <div className="muted" style={{ flexShrink: 0 }}>Loading…</div>}

      {/* ── Timeline view ─────────────────────────────────────────────────── */}
      {!loading && view === 'timeline' && (
        workingTherapists.length === 0 && appointments.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <div className="muted">No therapists are scheduled to work on this day.</div>
            <button className="primary" onClick={() => setModal({})} style={{ marginTop: 12 }}>+ Book anyway</button>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!isMobile && columnOrder && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, fontSize: 12, color: 'var(--muted)' }}>
                <span>⠿ Column order saved for {friendlyDate}</span>
                <button onClick={resetColumnOrder} style={{ fontSize: 11, padding: '2px 8px' }}>Reset to default</button>
              </div>
            )}
            <TimelineView
              appointments={appointments}
              therapistColumns={orderedTherapistColumns}
              workingTherapists={workingTherapists}
              selected={selected}
              onSelect={setSelected}
              onSlotClick={({ therapistId, time }) => setModal({ therapistId, time })}
              onEditClick={appt => setModal({ appointment: appt })}
              onColumnReorder={handleColumnReorder}
              isMobile={isMobile}
            />

            {/* Desktop action bar (inline, below timeline) */}
            {selected && !isMobile && (
              <div style={{ background: '#0D1B3E', color: 'white', padding: '11px 16px', borderRadius: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{selected.client_name || 'Walk-in'} — {selected.treatment_name}</div>
                  <div style={{ fontSize: 12, color: '#C9A84C' }}>
                    {fmtTime(selected.starts_at)} – {fmtTime(selected.ends_at)}
                    {selected.therapist_name && ` · ${selected.therapist_name}`}
                    {selected.room_name && ` · ${selected.room_name}`}
                    <span style={{ marginLeft: 8, background: 'rgba(201,168,76,0.2)', borderRadius: 4, padding: '1px 8px', textTransform: 'capitalize', color: '#C9A84C' }}>
                      {selected.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={{ background: 'rgba(255,255,255,0.15)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 7, padding: '7px 14px', cursor: 'pointer' }}
                    onClick={() => setModal({ appointment: selected })}>✏️ Edit</button>
                  {selected.status === 'booked' && (
                    <>
                      <button style={{ background: '#22c55e', color: 'white', border: 'none', borderRadius: 7, padding: '7px 16px', fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => setStatus(selected.id, 'in_progress')}>▶ Start</button>
                      <button style={{ background: 'rgba(255,255,255,0.15)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 7, padding: '7px 14px', cursor: 'pointer' }}
                        onClick={() => startCheckout(selected)}>🧾 Checkout</button>
                      <button style={{ background: '#ef4444', color: 'white', border: 'none', borderRadius: 7, padding: '7px 14px', cursor: 'pointer' }}
                        onClick={() => setStatus(selected.id, 'cancelled')}>✕ Cancel</button>
                    </>
                  )}
                  {selected.status === 'in_progress' && (
                    <button style={{ background: '#C9A84C', color: '#0D1B3E', border: 'none', borderRadius: 7, padding: '7px 18px', fontWeight: 700, cursor: 'pointer' }}
                      onClick={() => startCheckout(selected)}>🧾 Checkout</button>
                  )}
                  <button onClick={() => setSelected(null)} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: 7, padding: '7px 12px', cursor: 'pointer' }}>✕</button>
                </div>
              </div>
            )}
          </div>
        )
      )}

      {/* ── List view ─────────────────────────────────────────────────────── */}
      {!loading && view === 'list' && (
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {[
            { key: 'in_progress', title: '▶ In Progress' },
            { key: 'booked',      title: '📋 Upcoming'   },
            { key: 'completed',   title: '✅ Completed'   },
            { key: 'other',       title: '❌ Cancelled / No-show' },
          ].map(section => grouped[section.key].length > 0 && (
            <section key={section.key} className="col">
              <h3 style={{ margin: '12px 0 4px', fontSize: 15 }}>{section.title} ({grouped[section.key].length})</h3>
              <div className="col" style={{ gap: 8 }}>
                {grouped[section.key].map(a => (
                  <div key={a.id} className="card" style={{ padding: isMobile ? 12 : 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                          {fmtTime(a.starts_at)} – {fmtTime(a.ends_at)}
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)', marginTop: 1 }}>
                          {a.client_name || 'Walk-in'}
                        </div>
                        <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                          {a.treatment_name}
                          {a.therapist_name && ` · ${a.therapist_name}`}
                          {a.room_name && ` · ${a.room_name}`}
                        </div>
                        {/* Tap-to-call in list view */}
                        {a.client_phone && (
                          <a href={`tel:${a.client_phone}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, color: '#16a34a', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                            📞 {a.client_phone}
                          </a>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <span className={`status-pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
                        {a.status === 'booked' && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <button style={{ minHeight: isMobile ? 44 : 34 }} onClick={() => setStatus(a.id, 'in_progress')}>Start</button>
                            <button style={{ minHeight: isMobile ? 44 : 34 }} onClick={() => setStatus(a.id, 'cancelled')}>Cancel</button>
                            <button className="primary" style={{ minHeight: isMobile ? 44 : 34 }} onClick={() => startCheckout(a)}>Checkout</button>
                          </div>
                        )}
                        {a.status === 'in_progress' && (
                          <button className="gold" style={{ minHeight: isMobile ? 44 : 34, fontWeight: 700 }} onClick={() => startCheckout(a)}>🧾 Checkout</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {appointments.length === 0 && (
            <div className="card" style={{ textAlign: 'center', padding: 40 }}>
              <div className="muted">No appointments for this date.</div>
              <button className="primary" onClick={() => setModal({})} style={{ marginTop: 12 }}>+ Book the first one</button>
            </div>
          )}
        </div>
      )}

      {/* ── Mobile action sheet (slides up on appointment tap) ─────────────── */}
      {selected && isMobile && (
        <MobileActionSheet
          appt={selected}
          onClose={() => setSelected(null)}
          onEdit={appt => setModal({ appointment: appt })}
          onStatus={setStatus}
          onCheckout={startCheckout}
        />
      )}

      {/* ── New/edit appointment modal ──────────────────────────────────────── */}
      {modal !== null && (
        <NewAppointmentModal
          appointment={modal.appointment || null}
          defaultDate={date}
          defaultTherapistId={modal.therapistId || null}
          defaultStartsAt={modal.time || null}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); setSelected(null); load(); }}
        />
      )}

      {/* SPA-TURN-ORDER — set today's column order ─────────────────────── */}
      {showTurnModal && (
        <TurnOrderModal
          date={date}
          therapists={orderedTherapistColumns.filter(t => !t.isOff)}
          currentOrder={turnOrderToday}
          onClose={() => setShowTurnModal(false)}
          onSaved={() => { setShowTurnModal(false); refreshRota(month); }}
        />
      )}
    </div>
  );
}

// SPA-TURN-ORDER — modal for the receptionist to drag therapists into
// the day's working order. Saves to the server so all tablets see it
// (unlike the per-tablet drag-on-column-header behaviour, which stays
// as a one-off override).
function TurnOrderModal({ date, therapists, currentOrder, onClose, onSaved }) {
  const initial = currentOrder && currentOrder.length > 0
    ? [
        // Start with previously-saved order, drop anyone no longer in the list.
        ...currentOrder.filter(id => therapists.some(t => t.id === id)),
        // Then any new therapists not yet ordered, alphabetical.
        ...therapists.filter(t => !currentOrder.includes(t.id)).sort((a,b) => a.name.localeCompare(b.name)).map(t => t.id),
      ]
    : therapists.map(t => t.id);

  const [order, setOrder] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragSrc, setDragSrc] = useState(null);

  const byId = Object.fromEntries(therapists.map(t => [t.id, t]));

  function reorder(from, to) {
    setOrder(o => {
      const next = o.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }
  function moveUp(i) { if (i > 0) reorder(i, i - 1); }
  function moveDown(i) { if (i < order.length - 1) reorder(i, i + 1); }

  async function save() {
    setBusy(true); setError('');
    try {
      await api.put('/therapists/turn-order', { date, order });
      onSaved && onSaved();
    } catch (e) {
      setError(e.message || 'Failed to save order');
    } finally { setBusy(false); }
  }
  async function clearAll() {
    if (!confirm('Reset today\'s order to alphabetical?')) return;
    setBusy(true); setError('');
    try {
      await api.del(`/therapists/turn-order?date=${date}`);
      onSaved && onSaved();
    } catch (e) {
      setError(e.message || 'Failed to clear');
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>🔢 Turn order — {date}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
          Drag — or use the arrows — to set who takes which turn today.
          The first therapist gets column 1 on the timeline; new walk-ins go to whoever's next in line.
        </p>

        <div className="col" style={{ gap: 6, marginBottom: 12 }}>
          {order.length === 0 && <div className="muted">No therapists working today.</div>}
          {order.map((tid, i) => {
            const t = byId[tid];
            if (!t) return null;
            const isDragOver = dragSrc !== null && dragSrc !== i;
            return (
              <div
                key={tid}
                draggable
                onDragStart={() => setDragSrc(i)}
                onDragOver={e => { e.preventDefault(); }}
                onDrop={e => {
                  e.preventDefault();
                  if (dragSrc !== null && dragSrc !== i) reorder(dragSrc, i);
                  setDragSrc(null);
                }}
                onDragEnd={() => setDragSrc(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px',
                  background: dragSrc === i ? '#fdf6ec' : isDragOver ? '#f3f4f6' : 'white',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  cursor: 'grab',
                }}
              >
                <span style={{ color: '#C9A84C', fontWeight: 800, fontSize: 16, minWidth: 24, textAlign: 'right' }}>{i + 1}.</span>
                <span style={{ color: 'var(--muted)', fontSize: 14 }}>⠿</span>
                <span style={{ flex: 1, fontWeight: 600 }}>{t.name}</span>
                <button onClick={() => moveUp(i)}   disabled={i === 0}                   style={{ padding: '3px 9px', fontSize: 12 }}>↑</button>
                <button onClick={() => moveDown(i)} disabled={i === order.length - 1}    style={{ padding: '3px 9px', fontSize: 12 }}>↓</button>
              </div>
            );
          })}
        </div>

        {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}

        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <button onClick={clearAll} disabled={busy} style={{ fontSize: 12 }}>↻ Reset to alphabetical</button>
          <div className="row" style={{ gap: 6 }}>
            <button onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy || order.length === 0}>
              {busy ? 'Saving…' : 'Save order'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
