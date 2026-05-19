// SPA-ROTA-001 — Therapist Rota
// Weekly schedule grid (all therapists × Mon–Sun) + date-specific overrides.
// Weekly rota drives availability; overrides allow holidays / cover shifts.

import { useState, useEffect } from 'react';
import { api } from '../../api.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function pad(n) { return String(n).padStart(2, '0'); }

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function todayYM() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Weekly schedule slot editor ──────────────────────────────────────────────
function WeeklyEditor({ therapist, weeklyRota, onSave }) {
  const initial = () => {
    const slots = {};
    for (let d = 0; d < 7; d++) {
      const s = weeklyRota.find(r => r.therapist_id === therapist.id && r.day_of_week === d);
      slots[d] = s
        ? { working: true,  start: String(s.start_time).slice(0, 5), end: String(s.end_time).slice(0, 5) }
        : { working: false, start: '09:00', end: '18:00' };
    }
    return slots;
  };

  const [slots, setSlots] = useState(initial);
  const [saving, setSaving] = useState(false);

  const toggle = (d) =>
    setSlots(prev => ({ ...prev, [d]: { ...prev[d], working: !prev[d].working } }));

  const setTime = (d, field, val) =>
    setSlots(prev => ({ ...prev, [d]: { ...prev[d], [field]: val } }));

  const handleSave = async () => {
    setSaving(true);
    const slotArr = [];
    for (let d = 0; d < 7; d++) {
      if (slots[d].working) {
        slotArr.push({ day_of_week: d, start_time: slots[d].start, end_time: slots[d].end });
      }
    }
    try {
      await api.put(`/therapists/${therapist.id}/availability`, { slots: slotArr });
      onSave();
    } catch (e) {
      alert('Failed to save: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr 1fr', gap: '6px 10px', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Day</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Working</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Start</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>End</span>
        {DAYS.map((day, d) => (
          <>
            <span key={`lbl-${d}`} style={{ fontSize: 14, fontWeight: 500 }}>{day}</span>
            <label key={`tog-${d}`} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={slots[d].working}
                onChange={() => toggle(d)}
                style={{ width: 'auto', accentColor: 'var(--primary)' }}
              />
              <span style={{ fontSize: 13, color: slots[d].working ? 'var(--success)' : 'var(--muted)' }}>
                {slots[d].working ? 'Working' : 'Off'}
              </span>
            </label>
            <input key={`s-${d}`} type="time" value={slots[d].start} disabled={!slots[d].working}
              onChange={e => setTime(d, 'start', e.target.value)}
              style={{ width: 110, opacity: slots[d].working ? 1 : 0.35 }} />
            <input key={`e-${d}`} type="time" value={slots[d].end} disabled={!slots[d].working}
              onChange={e => setTime(d, 'end', e.target.value)}
              style={{ width: 110, opacity: slots[d].working ? 1 : 0.35 }} />
          </>
        ))}
      </div>
      <button className="primary" onClick={handleSave} disabled={saving} style={{ marginTop: 4 }}>
        {saving ? 'Saving…' : 'Save Weekly Schedule'}
      </button>
    </div>
  );
}

// ── Override editor modal ─────────────────────────────────────────────────────
function OverrideModal({ therapist, date, existing, onSave, onDelete, onClose }) {
  const [isWorking, setIsWorking] = useState(existing ? existing.is_working : false);
  const [start, setStart] = useState(existing?.start_time ? String(existing.start_time).slice(0, 5) : '09:00');
  const [end, setEnd]     = useState(existing?.end_time   ? String(existing.end_time).slice(0, 5)   : '18:00');
  const [note, setNote]   = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/therapists/${therapist.id}/overrides`, {
        date,
        is_working: isWorking,
        start_time: isWorking ? start : null,
        end_time:   isWorking ? end   : null,
        note:       note || null,
      });
      onSave();
    } catch (e) {
      alert('Failed to save: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await api.del(`/therapists/${therapist.id}/overrides/${date}`);
      onDelete();
    } catch (e) {
      alert('Failed to remove: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const [y, m, d] = date.split('-');
  const displayDate = new Date(Number(y), Number(m) - 1, Number(d))
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <h3 style={{ marginTop: 0, marginBottom: 4 }}>{therapist.name}</h3>
        <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 14 }}>{displayDate}</p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => setIsWorking(false)}
            className={!isWorking ? 'danger' : ''}
            style={{ flex: 1 }}
          >🚫 Day Off</button>
          <button
            onClick={() => setIsWorking(true)}
            className={isWorking ? 'primary' : ''}
            style={{ flex: 1 }}
          >✅ Custom Hours</button>
        </div>

        {isWorking && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label>Start time</label>
              <input type="time" value={start} onChange={e => setStart(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label>End time</label>
              <input type="time" value={end} onChange={e => setEnd(e.target.value)} />
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label>Note (optional)</label>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="e.g. Annual leave, covering for Maria…"
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={handleSave} disabled={saving} style={{ flex: 1 }}>
            {saving ? 'Saving…' : 'Save Override'}
          </button>
          {existing && (
            <button className="danger" onClick={handleDelete} disabled={saving}>
              Remove
            </button>
          )}
          <button onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Mini calendar for override view ──────────────────────────────────────────
function OverrideCalendar({ therapist, weeklyRota, overrides, month, onDayClick }) {
  const [y, m] = month.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayYMD();

  // Days the therapist works according to weekly rota
  const workingDays = new Set(
    weeklyRota
      .filter(r => r.therapist_id === therapist.id)
      .map(r => r.day_of_week),
  );

  const cells = [];
  // Empty prefix
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', fontWeight: 600, padding: '2px 0' }}>{d}</div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`e-${i}`} />;
          const dateStr = `${y}-${pad(m)}-${pad(d)}`;
          const dow = new Date(y, m - 1, d).getDay();
          const override = overrides.find(o => o.therapist_id === therapist.id && o.date === dateStr);
          const isOff = override
            ? !override.is_working
            : !workingDays.has(dow);
          const hasOverride = !!override;
          const isToday = dateStr === today;
          const isPast = dateStr < today;

          let bg = 'white';
          let color = 'var(--text)';
          let border = '1px solid var(--border)';
          if (isOff) { bg = '#f3f4f6'; color = 'var(--muted)'; }
          if (hasOverride && !isOff) { bg = '#fef3c7'; border = '1px solid #f59e0b'; }
          if (hasOverride && isOff)  { bg = '#fee2e2'; border = '1px solid #ef4444'; }
          if (isToday) border = '2px solid var(--primary)';

          return (
            <div
              key={dateStr}
              onClick={() => !isPast && onDayClick(dateStr)}
              style={{
                textAlign: 'center', fontSize: 13, padding: '6px 2px',
                borderRadius: 6, background: bg, color,
                border, cursor: isPast ? 'default' : 'pointer',
                opacity: isPast ? 0.5 : 1,
                fontWeight: isToday ? 700 : 400,
                position: 'relative',
              }}
              title={override?.note || (isOff ? 'Day off' : 'Working')}
            >
              {d}
              {hasOverride && (
                <span style={{ position: 'absolute', top: 2, right: 3, width: 5, height: 5, borderRadius: '50%', background: isOff ? '#ef4444' : '#f59e0b' }} />
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--muted)' }}>
        <span>⬜ Working</span>
        <span style={{ color: '#f59e0b' }}>🟨 Custom hours</span>
        <span style={{ color: '#ef4444' }}>🟥 Day off</span>
      </div>
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────
export default function RotaSection() {
  const [month, setMonth]       = useState(todayYM);
  const [data, setData]         = useState(null);   // { therapists, weekly_rota, overrides }
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState(null);   // therapist id with weekly editor open
  const [modal, setModal]       = useState(null);   // { therapist, date }
  const [view, setView]         = useState('grid'); // 'grid' | 'calendar'

  const load = async (m) => {
    setLoading(true); setError(null);
    try {
      const d = await api.get(`/therapists/rota?month=${m}`);
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(month); }, [month]);

  const handleMonthChange = (m) => { setMonth(m); setModal(null); };

  // ── Weekly grid summary ────────────────────────────────────────────────
  const renderGrid = () => {
    if (!data?.therapists?.length) return <p className="muted">No therapists found.</p>;
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)', width: 140 }}>Therapist</th>
              {DAYS.map(d => (
                <th key={d} style={{ padding: '8px 6px', borderBottom: '2px solid var(--border)', textAlign: 'center', fontWeight: 600 }}>{d}</th>
              ))}
              <th style={{ padding: '8px 6px', borderBottom: '2px solid var(--border)' }} />
            </tr>
          </thead>
          <tbody>
            {data.therapists.map(t => {
              const rotaForT = data.weekly_rota.filter(r => r.therapist_id === t.id);
              const isExpanded = expanded === t.id;
              return (
                <>
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 10px', fontWeight: 500 }}>
                      {t.name}
                      {t.specialisms && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.specialisms}</div>}
                    </td>
                    {[0,1,2,3,4,5,6].map(dow => {
                      const slot = rotaForT.find(r => r.day_of_week === dow);
                      return (
                        <td key={dow} style={{ padding: '8px 4px', textAlign: 'center' }}>
                          {slot ? (
                            <span style={{ fontSize: 11, color: 'var(--success)', display: 'block' }}>
                              ✓<br />
                              <span style={{ color: 'var(--muted)' }}>
                                {String(slot.start_time).slice(0,5)}<br />{String(slot.end_time).slice(0,5)}
                              </span>
                            </span>
                          ) : (
                            <span style={{ fontSize: 18, color: '#e5e7eb' }}>–</span>
                          )}
                        </td>
                      );
                    })}
                    <td style={{ padding: '8px 4px' }}>
                      <button
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => setExpanded(isExpanded ? null : t.id)}
                      >
                        {isExpanded ? 'Close' : 'Edit'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${t.id}-editor`}>
                      <td colSpan={9} style={{ padding: '12px 16px', background: '#fafaf9', borderBottom: '1px solid var(--border)' }}>
                        <WeeklyEditor
                          therapist={t}
                          weeklyRota={data.weekly_rota}
                          onSave={() => { load(month); setExpanded(null); }}
                        />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // ── Override calendars ────────────────────────────────────────────────
  const renderCalendars = () => {
    if (!data?.therapists?.length) return <p className="muted">No therapists found.</p>;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {data.therapists.map(t => (
          <div key={t.id} className="card">
            <h4 style={{ margin: '0 0 12px', fontSize: 15 }}>{t.name}</h4>
            <OverrideCalendar
              therapist={t}
              weeklyRota={data.weekly_rota}
              overrides={data.overrides}
              month={month}
              onDayClick={(date) => setModal({ therapist: t, date })}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>🗓 Therapist Rota</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={view === 'grid' ? 'primary' : ''}
            onClick={() => setView('grid')}
            style={{ fontSize: 13 }}
          >Weekly Schedule</button>
          <button
            className={view === 'calendar' ? 'primary' : ''}
            onClick={() => setView('calendar')}
            style={{ fontSize: 13 }}
          >Override Calendar</button>
        </div>
      </div>

      {/* Month navigator (only shown on calendar view) */}
      {view === 'calendar' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => handleMonthChange(prevMonth(month))} style={{ padding: '6px 12px' }}>‹</button>
          <span style={{ fontWeight: 600, minWidth: 160, textAlign: 'center' }}>{monthLabel(month)}</span>
          <button onClick={() => handleMonthChange(nextMonth(month))} style={{ padding: '6px 12px' }}>›</button>
        </div>
      )}

      {loading && <p className="muted">Loading…</p>}
      {error   && <p style={{ color: 'var(--danger)' }}>Error: {error}</p>}

      {!loading && !error && (
        <>
          {view === 'grid'     && renderGrid()}
          {view === 'calendar' && renderCalendars()}
        </>
      )}

      {/* How-to hint */}
      {view === 'calendar' && !loading && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          Click any future date to set a day off or custom hours for that therapist.
          Overrides override the weekly schedule for that date only.
        </p>
      )}

      {/* Override modal */}
      {modal && (
        <OverrideModal
          therapist={modal.therapist}
          date={modal.date}
          existing={data?.overrides?.find(o => o.therapist_id === modal.therapist.id && o.date === modal.date)}
          onSave={() => { load(month); setModal(null); }}
          onDelete={() => { load(month); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
