// SPA-ROTA-001 — Therapist Rota
// Two tabs:
//  1. Weekly Schedule — set each therapist's working days/hours
//  2. Override Calendar — mark day-off or custom hours for specific dates

import { useState, useEffect } from 'react';
import { api } from '../../api.js';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function pad(n) { return String(n).padStart(2,'0'); }
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function todayYM() { return todayYMD().slice(0,7); }
function prevMonth(ym) {
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m-2, 1);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
}
function nextMonth(ym) {
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
}
function monthLabel(ym) {
  const [y,m] = ym.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-GB', { month:'long', year:'numeric' });
}

// ── Weekly schedule editor for one therapist ─────────────────────────────────
function WeeklyEditor({ therapist, weeklyRota, onSave }) {
  const init = () => {
    const slots = {};
    for (let d = 0; d < 7; d++) {
      const s = weeklyRota.find(r => r.therapist_id === therapist.id && r.day_of_week === d);
      slots[d] = s
        ? { working: true,  start: String(s.start_time).slice(0,5), end: String(s.end_time).slice(0,5) }
        : { working: false, start: '09:00', end: '18:00' };
    }
    return slots;
  };
  const [slots,  setSlots]  = useState(init);
  const [saving, setSaving] = useState(false);

  const toggle  = d => setSlots(p => ({ ...p, [d]: { ...p[d], working: !p[d].working } }));
  const setTime = (d, f, v) => setSlots(p => ({ ...p, [d]: { ...p[d], [f]: v } }));

  const handleSave = async () => {
    setSaving(true);
    const arr = [];
    for (let d = 0; d < 7; d++) {
      if (slots[d].working) arr.push({ day_of_week: d, start_time: slots[d].start, end_time: slots[d].end });
    }
    try {
      await api.put(`/therapists/${therapist.id}/availability`, { slots: arr });
      onSave();
    } catch (e) { alert('Failed to save: ' + e.message); }
    finally { setSaving(false); }
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
            <span key={`l-${d}`} style={{ fontSize: 14, fontWeight: 500 }}>{day}</span>
            <label key={`t-${d}`} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', margin: 0 }}>
              <input type="checkbox" checked={slots[d].working} onChange={() => toggle(d)}
                style={{ width: 'auto', accentColor: 'var(--primary)' }} />
              <span style={{ fontSize: 13, color: slots[d].working ? 'var(--success)' : 'var(--muted)' }}>
                {slots[d].working ? 'Working' : 'Off'}
              </span>
            </label>
            <input key={`s-${d}`} type="time" value={slots[d].start} disabled={!slots[d].working}
              onChange={e => setTime(d, 'start', e.target.value)}
              style={{ opacity: slots[d].working ? 1 : 0.35 }} />
            <input key={`e-${d}`} type="time" value={slots[d].end} disabled={!slots[d].working}
              onChange={e => setTime(d, 'end', e.target.value)}
              style={{ opacity: slots[d].working ? 1 : 0.35 }} />
          </>
        ))}
      </div>
      <button className="primary" onClick={handleSave} disabled={saving} style={{ marginTop: 4 }}>
        {saving ? 'Saving…' : 'Save Weekly Schedule'}
      </button>
    </div>
  );
}

// ── Weekly grid overview ──────────────────────────────────────────────────────
function WeeklyTab({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(null);
  if (!data?.therapists?.length) return <p className="muted">No therapists found.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Summary grid */}
      <div style={{ overflowX: 'auto', marginBottom: 8 }}>
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
              const rotaForT   = data.weekly_rota.filter(r => r.therapist_id === t.id);
              const isExpanded = expanded === t.id;
              return (
                <>
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px', fontWeight: 500 }}>
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
                      <button style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => setExpanded(isExpanded ? null : t.id)}>
                        {isExpanded ? 'Close' : 'Edit'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${t.id}-ed`}>
                      <td colSpan={9} style={{ padding: '12px 16px', background: '#fafaf9', borderBottom: '1px solid var(--border)' }}>
                        <WeeklyEditor therapist={t} weeklyRota={data.weekly_rota}
                          onSave={() => { onRefresh(); setExpanded(null); }} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Override modal ────────────────────────────────────────────────────────────
function OverrideModal({ therapist, date, existing, onSave, onDelete, onClose }) {
  const [isWorking, setIsWorking] = useState(existing ? existing.is_working : false);
  const [start, setStart] = useState(existing?.start_time ? String(existing.start_time).slice(0,5) : '09:00');
  const [end,   setEnd]   = useState(existing?.end_time   ? String(existing.end_time).slice(0,5)   : '18:00');
  const [note,  setNote]  = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);

  const [y, m, d] = date.split('-');
  const displayDate = new Date(+y, +m-1, +d).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/therapists/${therapist.id}/overrides`, {
        date, is_working: isWorking,
        start_time: isWorking ? start : null,
        end_time:   isWorking ? end   : null,
        note: note || null,
      });
      onSave();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };
  const handleDelete = async () => {
    setSaving(true);
    try { await api.del(`/therapists/${therapist.id}/overrides/${date}`); onDelete(); }
    catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <h3 style={{ margin: '0 0 4px' }}>{therapist.name}</h3>
        <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 14 }}>{displayDate}</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={() => setIsWorking(false)} className={!isWorking ? 'danger' : ''} style={{ flex: 1 }}>🚫 Day Off</button>
          <button onClick={() => setIsWorking(true)}  className={isWorking  ? 'primary' : ''} style={{ flex: 1 }}>✅ Custom Hours</button>
        </div>
        {isWorking && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}><label>Start time</label><input type="time" value={start} onChange={e => setStart(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label>End time</label>  <input type="time" value={end}   onChange={e => setEnd(e.target.value)} /></div>
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <label>Note (optional)</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Annual leave, covering for Maria…" />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={handleSave} disabled={saving} style={{ flex: 1 }}>{saving ? 'Saving…' : 'Save Override'}</button>
          {existing && <button className="danger" onClick={handleDelete} disabled={saving}>Remove</button>}
          <button onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Override calendar ─────────────────────────────────────────────────────────
function OverridesTab({ data, month, setMonth, onRefresh }) {
  const [modal, setModal] = useState(null);
  const [y, m] = month.split('-').map(Number);
  const firstDow  = new Date(y, m-1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();
  const today     = todayYMD();

  if (!data?.therapists?.length) return <p className="muted">No therapists found.</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={() => setMonth(prevMonth(month))} style={{ padding: '6px 12px' }}>‹</button>
        <span style={{ fontWeight: 600, minWidth: 160, textAlign: 'center' }}>{monthLabel(month)}</span>
        <button onClick={() => setMonth(nextMonth(month))} style={{ padding: '6px 12px' }}>›</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
        {data.therapists.map(t => {
          const workDays = new Set(data.weekly_rota.filter(r => r.therapist_id === t.id).map(r => r.day_of_week));
          const cells = [];
          for (let i = 0; i < firstDow; i++) cells.push(null);
          for (let d = 1; d <= daysInMon; d++) cells.push(d);

          return (
            <div key={t.id} className="card">
              <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 14 }}>{t.name}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 6 }}>
                {DAYS.map(d => (
                  <div key={d} style={{ textAlign:'center', fontSize:10, color:'var(--muted)', fontWeight:600, padding:'2px 0' }}>{d}</div>
                ))}
                {cells.map((d, i) => {
                  if (!d) return <div key={`e-${i}`} />;
                  const dstr   = `${y}-${pad(m)}-${pad(d)}`;
                  const dow    = new Date(y, m-1, d).getDay();
                  const ov     = data.overrides.find(o => o.therapist_id === t.id && o.date === dstr);
                  const isOff  = ov ? !ov.is_working : !workDays.has(dow);
                  const isPast = dstr < today, isToday = dstr === today;
                  let bg = isOff ? '#f3f4f6' : 'white', border = '1px solid var(--border)';
                  if (ov && !isOff) { bg = '#fef3c7'; border = '1px solid #f59e0b'; }
                  if (ov &&  isOff) { bg = '#fee2e2'; border = '1px solid #ef4444'; }
                  if (isToday) border = '2px solid var(--primary)';
                  return (
                    <div key={dstr} onClick={() => setModal({ therapist: t, date: dstr })}
                      title={ov?.note || (isOff ? 'Day off' : 'Working')}
                      style={{ textAlign:'center', fontSize:12, padding:'5px 2px', borderRadius:5,
                        background: bg, border, cursor: 'pointer',
                        opacity: isPast ? 0.65 : 1, fontWeight: isToday ? 700 : 400, position:'relative' }}>
                      {d}
                      {ov && <span style={{ position:'absolute', top:1, right:2, width:4, height:4, borderRadius:'50%', background: isOff ? '#ef4444' : '#f59e0b' }} />}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize:11, color:'var(--muted)', display:'flex', gap:8 }}>
                <span>⬜ Working</span>
                <span style={{ color:'#f59e0b' }}>🟨 Custom hours</span>
                <span style={{ color:'#ef4444' }}>🟥 Day off</span>
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize:12, color:'var(--muted)', marginTop:12 }}>
        Click any date to set a day off or custom hours for that therapist.
      </p>

      {modal && (
        <OverrideModal
          therapist={modal.therapist} date={modal.date}
          existing={data.overrides.find(o => o.therapist_id === modal.therapist.id && o.date === modal.date)}
          onSave={() => { onRefresh(); setModal(null); }}
          onDelete={() => { onRefresh(); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function RotaSection() {
  const [tab,     setTab]      = useState('weekly');
  const [month,   setMonth]    = useState(todayYM());
  const [data,    setData]     = useState(null);
  const [loading, setLoading]  = useState(false);

  const load = async (m) => {
    setLoading(true);
    try { const d = await api.get(`/therapists/rota?month=${m}`); setData(d); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(month); }, []);

  const handleMonthChange = (m) => { setMonth(m); load(m); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="section-header">
        <div>
          <h2>Rota</h2>
          <div className="sub">Weekly schedules and date-specific overrides</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={tab === 'weekly'    ? 'primary' : ''} onClick={() => setTab('weekly')}    style={{ fontSize: 13 }}>Weekly Schedule</button>
          <button className={tab === 'overrides' ? 'primary' : ''} onClick={() => setTab('overrides')} style={{ fontSize: 13 }}>Override Calendar</button>
        </div>
      </div>

      {tab === 'overrides' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* month nav handled inside OverridesTab */}
        </div>
      )}

      {loading && <p className="muted">Loading…</p>}

      {!loading && data && (
        <>
          {tab === 'weekly'    && <WeeklyTab    data={data} onRefresh={() => load(month)} />}
          {tab === 'overrides' && <OverridesTab data={data} month={month} setMonth={handleMonthChange} onRefresh={() => load(month)} />}
        </>
      )}
    </div>
  );
}
