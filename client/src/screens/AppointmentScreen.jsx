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

// Given rota data, returns true if therapist is working on dateStr
function isWorkingOn(therapistId, dateStr, weeklyRota, overrides) {
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun
  // 1. Check date-specific override first
  const override = overrides.find(o => o.therapist_id === therapistId && o.date?.slice(0, 10) === dateStr);
  if (override) return Boolean(override.is_working);
  // 2. Check weekly rota
  const entry = weeklyRota.find(r => r.therapist_id === therapistId && r.day_of_week === dayOfWeek);
  if (entry) return true;
  // 3. No rota at all → show (backwards compat)
  const hasAnyRota = weeklyRota.some(r => r.therapist_id === therapistId);
  return !hasAnyRota;
}

// Returns custom work hours { start: 'HH:MM', end: 'HH:MM' } for a therapist on a date,
// or null if they work the full day / no restriction applies.
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

// Payment method → colour. Korakot's chosen palette:
//   Cash → orange · Card → pink · Voucher → green · Treatwell → yellow
// Split kept on violet so it stays visually distinct from the four named
// methods; `other` is the grey fallback for legacy / unknown values.
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
const COL_W     = 154;
const LBL_W     = 52;
const DAY_START = 9;
const DAY_END   = 21;
const NUM_HOURS = DAY_END - DAY_START;
const HEADER_H  = 52;   // sticky therapist-name header height

const STATUS_STYLE = {
  booked:      { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
  in_progress: { bg: '#dcfce7', border: '#22c55e', text: '#14532d' },
  completed:   { bg: '#f3f4f6', border: '#9ca3af', text: '#4b5563' }, // fallback when no payment method
  cancelled:   { bg: '#f3f4f6', border: '#9ca3af', text: '#4b5563' },
  no_show:     { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
};
// Completed appointments use payment method colour instead of generic purple.
// Tints match PAYMENT_COLOR above (Korakot's mapping):
//   Cash → orange · Card → pink · Voucher → green · Treatwell → yellow
const PAYMENT_STYLE = {
  cash:      { bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
  card:      { bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },
  voucher:   { bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
  treatwell: { bg: '#fef9c3', border: '#eab308', text: '#854d0e' },
  split:     { bg: '#ede9fe', border: '#7c3aed', text: '#4c1d95' },
};
function apptStyle(a) {
  if (a.status === 'completed' && a.payment_method) {
    return PAYMENT_STYLE[a.payment_method] || { bg: '#e0e7ff', border: '#8b5cf6', text: '#4c1d95' };
  }
  return STATUS_STYLE[a.status] || STATUS_STYLE.booked;
}
// Selected-block highlight colours — navy shades so they feel on-brand
const COL_COLORS = ['#1e3a6e','#2a4f8f','#142952','#1a3d7a','#243d6b','#1e4a8a'];

function toLocalMins(iso) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }

// ══════════════════════════════════════════════════════════════════════════════
// VERTICAL TIMELINE
// ══════════════════════════════════════════════════════════════════════════════
function TimelineView({ appointments, therapistColumns, workingTherapists, selected, onSelect, onSlotClick, onEditClick, onColumnReorder }) {
  const nowRef       = useRef(null);
  const containerRef = useRef(null);
  const [containerH, setContainerH] = useState(0);
  const [dragSrc,  setDragSrc]  = useState(null);  // column index being dragged
  const [dragOver, setDragOver] = useState(null);  // column index being hovered

  // Measure the container and recompute HOUR_H whenever it resizes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setContainerH(entries[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // HOUR_H = grid area height / number of hours. Fall back to 64px until measured.
  // Subtract header (52px) + legend bar (32px) + 2px border buffer
  const gridH  = containerH > 100 ? containerH - HEADER_H - 34 : NUM_HOURS * 64;
  const HOUR_H = Math.floor(gridH / NUM_HOURS);
  const totalH = HOUR_H * NUM_HOURS;

  function minsToPx(mins) { return ((mins - DAY_START * 60) / 60) * HOUR_H; }

  const hours = Array.from({ length: NUM_HOURS + 1 }, (_, i) => DAY_START + i);

  // Cancelled / no-show appointments are hidden from the timeline so they
  // don't block the slot from being clicked to create a new booking.
  // They remain visible in List view.
  const visibleAppts = appointments.filter(a => !['cancelled', 'no_show'].includes(a.status));

  // Build columns: start from all working therapists, then merge in appointment data
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
    // Show every therapist (with isOff flag), plus any appointments from therapists not in rota
    columns = sourceList.map(t => ({ id: t.id, name: t.name, isOff: !!t.isOff, workStart: t.workStart || null, workEnd: t.workEnd || null, appts: apptMap[t.id] || [] }));
    // Safety net: also include appointments assigned to therapists not in the rota list
    Object.keys(apptMap).forEach(tid => {
      const id = Number(tid);
      if (!columns.find(c => c.id === id)) {
        const name = visibleAppts.find(a => a.therapist_id === id)?.therapist_name || 'Unassigned';
        columns.push({ id, name, isOff: false, appts: apptMap[tid] });
      }
    });
  } else {
    // Fallback: derive columns from visible appointments only
    const map = {};
    visibleAppts.forEach(a => {
      const key = a.therapist_id || 0;
      if (!map[key]) map[key] = { id: key, name: a.therapist_name || 'Unassigned', appts: [] };
      map[key].appts.push(a);
    });
    columns = Object.values(map);
  }
  columns.sort((a, b) => a.name.localeCompare(b.name));

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
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
      <div style={{ minWidth: LBL_W + columns.length * COL_W, flex: 1, position: 'relative', overflowY: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 20, background: '#1e3a6e' }}>
          <div style={{ width: LBL_W, flexShrink: 0 }} />
          {columns.map((col, ci) => {
            const activeAppts = col.appts.filter(a => !['cancelled','no_show'].includes(a.status));
            // Hours worked = sum of non-cancelled appointment durations
            const workedMins = activeAppts.reduce((sum, a) =>
              sum + (new Date(a.ends_at) - new Date(a.starts_at)) / 60000, 0);
            const workedLabel = workedMins >= 60
              ? `${Math.floor(workedMins / 60)}h${workedMins % 60 ? ` ${workedMins % 60}m` : ''}`
              : workedMins > 0 ? `${workedMins}m` : '';
            const isDragTarget = dragOver === ci && dragSrc !== null && dragSrc !== ci;
            return (
              <div key={col.id}
                draggable
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
                  width: COL_W, flexShrink: 0, padding: '8px 8px', textAlign: 'center',
                  borderLeft: isDragTarget ? '2px solid #C9A84C' : '1px solid rgba(255,255,255,0.18)',
                  opacity: col.isOff ? 0.55 : dragSrc === ci ? 0.4 : 1,
                  cursor: 'grab',
                  background: isDragTarget ? 'rgba(201,168,76,0.2)' : 'transparent',
                  transition: 'background 0.1s, border-color 0.1s',
                  userSelect: 'none',
                }}>
                {/* Grip + name row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '-1px' }}>⠿</span>
                  <span style={{ fontWeight: 700, fontSize: 13, color: col.isOff ? 'rgba(255,255,255,0.6)' : 'white' }}>{col.name}</span>
                </div>
                {/* Appt count */}
                <div style={{ fontSize: 11, marginTop: 1, color: col.isOff ? 'rgba(255,200,100,0.55)' : '#f5c07a' }}>
                  {col.isOff
                    ? 'Off today'
                    : activeAppts.length === 0 ? 'free' : `${activeAppts.length} appt${activeAppts.length !== 1 ? 's' : ''}`}
                </div>
                {/* Hours worked */}
                {!col.isOff && workedLabel && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>
                    {workedLabel} booked
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Grid */}
        <div style={{ display: 'flex', position: 'relative' }}>

          {/* Time axis */}
          <div style={{ width: LBL_W, flexShrink: 0, position: 'sticky', left: 0, zIndex: 10, background: 'white' }}>
            {hours.map(h => (
              <div key={h} style={{ height: HOUR_H, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', paddingTop: 5, paddingRight: 8, justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>{pad(h)}:00</span>
              </div>
            ))}
          </div>

          {/* Columns */}
          {columns.map((col, ci) => {
            // Compute blocked-hours bands for custom rota times (#29)
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
                width: COL_W, flexShrink: 0, position: 'relative', height: totalH,
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
                // Block clicks outside custom work hours (#29)
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

              {/* Blocked-hours overlay — outside custom rota start/end (#29) */}
              {blockedBands.map((band, bi) => (
                <div key={bi} style={{
                  position: 'absolute', top: band.top, left: 0, right: 0, height: band.height,
                  background: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.035) 0px, rgba(0,0,0,0.035) 7px, transparent 7px, transparent 14px)',
                  borderTop: band.borderSide === 'top' ? '1.5px dashed #d1d5db' : 'none',
                  borderBottom: band.borderSide === 'bottom' ? '1.5px dashed #d1d5db' : 'none',
                  pointerEvents: 'none', zIndex: 2,
                }} />
              ))}

              {/* Appointment blocks — single click selects, double-click edits */}
              {col.appts.map(a => {
                const startM = toLocalMins(a.starts_at);
                const endM   = toLocalMins(a.ends_at);
                const top    = minsToPx(startM);
                const height = Math.max(minsToPx(endM) - minsToPx(startM) - 3, 26);
                const isSel  = selected?.id === a.id;
                const s      = apptStyle(a);
                const hasPm  = Boolean(a.payment_method);  // #30
                const isReq  = Boolean(a.therapist_requested); // #31
                return (
                  <div key={a.id}
                    onClick={e => { e.stopPropagation(); onSelect(isSel ? null : a); }}
                    onDoubleClick={e => { e.stopPropagation(); onEditClick && onEditClick(a); }}
                    title={[
                      'Click to select · Double-click to edit',
                      isReq ? '⭐ Therapist requested' : '',
                      hasPm ? `💳 Paid by ${a.payment_method}` : '',
                    ].filter(Boolean).join(' · ')}
                    style={{
                      position: 'absolute', left: 4, right: 4, top, height,
                      borderRadius: 7, cursor: 'pointer',
                      background: isSel ? COL_COLORS[ci % COL_COLORS.length] : s.bg,
                      border: `2px solid ${isSel ? COL_COLORS[ci % COL_COLORS.length] : s.border}`,
                      padding: '4px 7px', overflow: 'hidden',
                      boxShadow: isSel ? '0 4px 14px rgba(0,0,0,0.22)' : '0 1px 4px rgba(0,0,0,0.07)',
                      zIndex: isSel ? 8 : 4, transition: 'all 0.12s',
                    }}>
                    {/* Client name + therapist-requested star (#31) */}
                    <div style={{ fontSize: 12, fontWeight: 700, color: isSel ? 'white' : s.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {isReq && <span title="Client requested this therapist" style={{ marginRight: 3, fontSize: 10 }}>⭐</span>}
                      {a.client_name || 'Walk-in'}
                    </div>
                    {height > 38 && (
                      <div style={{ fontSize: 11, color: isSel ? 'rgba(255,255,255,0.85)' : s.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.9 }}>
                        {a.treatment_name}
                      </div>
                    )}
                    {height > 54 && (
                      <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.7)' : s.text, opacity: 0.75 }}>
                        {fmtTime(a.starts_at)} – {fmtTime(a.ends_at)}
                      </div>
                    )}
                    {height > 68 && a.room_name && (
                      <div style={{ fontSize: 10, color: isSel ? 'rgba(255,255,255,0.65)' : s.text, opacity: 0.7 }}>
                        🚪 {a.room_name}
                      </div>
                    )}
                    {/* Payment method badge (#30) — shown when paid */}
                    {hasPm && height > 46 && (
                      <div style={{
                        position: 'absolute', bottom: 4, right: 5,
                        fontSize: 9, fontWeight: 700, lineHeight: 1,
                        background: isSel ? 'rgba(255,255,255,0.25)' : pmColor(a.payment_method),
                        color: 'white',
                        padding: '2px 5px', borderRadius: 3,
                      }}>
                        {pmLabel(a.payment_method)}
                      </div>
                    )}
                    {/* Edit hint on selected */}
                    {isSel && height > 46 && (
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
              <div style={{ width: LBL_W, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', paddingRight: 4 }}>
                <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 700 }}>{pad(now.getHours())}:{pad(now.getMinutes())}</span>
              </div>
              <div style={{ flex: 1, height: 2, background: '#ef4444', opacity: 0.7 }} />
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ padding: '8px 12px', background: '#fafafa', borderTop: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Status colours — exclude 'completed' since it's replaced by payment colours */}
        {Object.entries(STATUS_STYLE).filter(([s]) => s !== 'completed').map(([status, s]) => (
          <span key={status} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.bg, border: `2px solid ${s.border}`, display: 'inline-block' }} />
            <span style={{ color: 'var(--muted)', textTransform: 'capitalize' }}>{status.replace('_', ' ')}</span>
          </span>
        ))}
        <span style={{ width: 1, height: 14, background: 'var(--border)', display: 'inline-block' }} />
        {/* Paid = completed with payment method colour */}
        {Object.entries(PAYMENT_STYLE).map(([method, s]) => (
          <span key={method} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.bg, border: `2px solid ${s.border}`, display: 'inline-block' }} />
            <span style={{ color: 'var(--muted)', textTransform: 'capitalize' }}>Paid · {method}</span>
          </span>
        ))}
        <span style={{ width: 1, height: 14, background: 'var(--border)', display: 'inline-block' }} />
        <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10 }}>⭐</span> Therapist requested
        </span>
      </div>
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
  // Modal state — null = closed, {} = new, { appointment } = edit, { therapistId, time } = click-to-book
  const [modal, setModal]             = useState(null);
  // Rota state
  const [allTherapists, setAllTherapists] = useState([]);
  const [weeklyRota, setWeeklyRota]       = useState([]);
  const [rotaOverrides, setRotaOverrides] = useState([]);
  const [rotaMonth, setRotaMonth]         = useState('');
  // Column order — persisted per-date in localStorage so reception can set arrival order
  const [columnOrder, setColumnOrder]     = useState(null);
  const navigate = useNavigate();

  // Load rota data when the month changes — also exposed as a callback so
  // the socket listener below can force a refetch when an override is
  // added/edited elsewhere (Admin → Rota). Without this, the per-month
  // cache (rotaMonth === month) kept the timeline showing the old window.
  const month = date.slice(0, 7);
  const refreshRota = useCallback(async (m) => {
    try {
      const r = await api.get(`/therapists/rota?month=${m}`);
      setAllTherapists(r.therapists || []);
      setWeeklyRota(r.weekly_rota || []);
      setRotaOverrides(r.overrides || []);
      setRotaMonth(m);
    } catch { /* fall back to appointment-derived columns */ }
  }, []);

  useEffect(() => {
    if (month !== rotaMonth) refreshRota(month);
  }, [month, rotaMonth, refreshRota]);

  // Live refresh when the rota or any override changes elsewhere.
  useEffect(() => {
    const onRotaUpdated = () => refreshRota(month);
    socket.on('rota_updated', onRotaUpdated);
    return () => socket.off('rota_updated', onRotaUpdated);
  }, [month, refreshRota]);

  // Load saved column order when date changes
  useEffect(() => {
    const saved = localStorage.getItem(`spa_col_order_${date}`);
    setColumnOrder(saved ? JSON.parse(saved) : null);
  }, [date]);

  // All therapists shown on timeline; isOff + workStart/workEnd drive column visual state
  const therapistColumns = allTherapists
    .filter(t => t.role === 'therapist')
    .map(t => {
      const isOff = !isWorkingOn(t.id, date, weeklyRota, rotaOverrides);
      const hours = isOff ? null : getWorkHours(t.id, date, weeklyRota, rotaOverrides);
      return { ...t, isOff, workStart: hours?.start || null, workEnd: hours?.end || null };
    });

  // Apply saved column order (per-date, set by reception)
  const orderedTherapistColumns = columnOrder
    ? [...therapistColumns].sort((a, b) => {
        const ai = columnOrder.indexOf(a.id);
        const bi = columnOrder.indexOf(b.id);
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

  // Keep backwards-compat: workingTherapists still used for "no staff" fallback message
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

  // The outer div uses the full viewport minus the top nav (~57px) and main padding (20px top).
  // overflow:hidden keeps the page body from growing a scrollbar.
  return (
    <div className="col" style={{ height: 'calc(100vh - 97px)', overflow: 'hidden', gap: 8 }}>
      {/* Top bar */}
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
          <button className="primary" onClick={() => setModal({})}>+ New</button>
        </div>
      </div>

      {loading && <div className="muted" style={{ flexShrink: 0 }}>Loading…</div>}

      {/* Timeline view */}
      {!loading && view === 'timeline' && (
        workingTherapists.length === 0 && appointments.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <div className="muted">No therapists are scheduled to work on this day.</div>
            <button className="primary" onClick={() => setModal({})} style={{ marginTop: 12 }}>+ Book anyway</button>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {columnOrder && (
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
            />
            {/* Action bar when an appointment is selected */}
            {selected && (
              <div style={{ background: '#1e3a6e', color: 'white', padding: '11px 16px', borderRadius: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
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
                  {/* Edit always available */}
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
                    <button style={{ background: '#C9A84C', color: '#1e3a6e', border: 'none', borderRadius: 7, padding: '7px 18px', fontWeight: 700, cursor: 'pointer' }}
                      onClick={() => startCheckout(selected)}>🧾 Checkout</button>
                  )}
                  <button onClick={() => setSelected(null)} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: 7, padding: '7px 12px', cursor: 'pointer' }}>✕</button>
                </div>
              </div>
            )}
          </div>
        )
      )}

      {/* List view */}
      {!loading && view === 'list' && (
        <>
          {[
            { key: 'in_progress', title: '▶ In Progress' },
            { key: 'booked',      title: '📋 Upcoming' },
            { key: 'completed',   title: '✅ Completed' },
            { key: 'other',       title: '❌ Cancelled / No-show' },
          ].map(section => grouped[section.key].length > 0 && (
            <section key={section.key} className="col">
              <h3 style={{ margin: '12px 0 4px', fontSize: 15 }}>{section.title} ({grouped[section.key].length})</h3>
              <div className="col" style={{ gap: 8 }}>
                {grouped[section.key].map(a => (
                  <div key={a.id} className="card" style={{ padding: 12 }}>
                    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{fmtTime(a.starts_at)} – {fmtTime(a.ends_at)} · {a.treatment_name || '—'}</div>
                        <div className="muted" style={{ fontSize: 14 }}>
                          {a.client_name || 'Walk-in'}{a.client_phone && ` · ${a.client_phone}`}
                          {a.therapist_name && ` · ${a.therapist_name}`}
                          {a.room_name && ` · ${a.room_name}`}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <span className={`status-pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
                        {a.status === 'booked' && (
                          <>
                            <button onClick={() => setStatus(a.id, 'in_progress')}>Start</button>
                            <button onClick={() => setStatus(a.id, 'cancelled')}>Cancel</button>
                            <button onClick={() => startCheckout(a)}>Checkout</button>
                          </>
                        )}
                        {a.status === 'in_progress' && (
                          <button className="primary" onClick={() => startCheckout(a)}>Checkout</button>
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
        </>
      )}

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
    </div>
  );
}
