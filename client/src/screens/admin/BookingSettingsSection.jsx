import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const KEYS = [
  { k: 'opening_time',             t: 'Opening time',                            type: 'time'   },
  { k: 'closing_time',             t: 'Closing time',                            type: 'time'   },
  { k: 'booking_slot_minutes',     t: 'Slot size (minutes)',                     type: 'number' },
  { k: 'booking_advance_days',     t: 'Advance booking window (days)',           type: 'number' },
  { k: 'cancel_policy_text',       t: 'Cancellation policy (shown on widget)',   type: 'text'   },
  { k: 'tip_suggestions',          t: 'Tip suggestions (% — comma separated)',   type: 'text'   },
  { k: 'vat_rate',                 t: 'VAT rate (%)',                            type: 'number' },
];

export default function BookingSettingsSection() {
  const [settings, setSettings] = useState({});
  const [busy, setBusy]         = useState(false);

  const load = useCallback(async () => {
    const r = await api.get('/settings');
    setSettings(r.settings);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(key, value) {
    setBusy(true);
    try {
      await api.put('/settings', { key, value });
      setSettings((s) => ({ ...s, [key]: value }));
    } finally { setBusy(false); }
  }

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Booking Settings</h2>
          <div className="sub">Configure the public booking widget and spa behaviour</div>
        </div>
      </div>
      <div className="card col">
      <h3 style={{ margin: 0 }}>Booking & spa settings</h3>
      {KEYS.map((row) => (
        <SettingRow
          key={row.k}
          row={row}
          value={settings[row.k] ?? ''}
          busy={busy}
          onSave={(v) => save(row.k, v)}
        />
      ))}
      </div>
      <PromotionsCard value={settings.time_promotions} busy={busy} onSave={(v) => save('time_promotions', v)} />
    </div>
  );
}

// ── SPA-PROMO-TIME-001 — time-based promotions ("10:00–16:00 = 5% off") ──────
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function PromotionsCard({ value, busy, onSave }) {
  const parse = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const [rules, setRules] = useState(() => parse(value));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setRules(parse(value)); setDirty(false); }, [value]);

  const update = (i, patch) => { setRules((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x))); setDirty(true); };
  const remove = (i) => { setRules((r) => r.filter((_, j) => j !== i)); setDirty(true); };
  const add = () => { setRules((r) => [...r, { id: String(Date.now()), name: 'Daytime offer', percent: 5, start: '10:00', end: '16:00', days: [1, 2, 3, 4, 5], channels: 'all', active: true }]); setDirty(true); };
  const toggleDay = (i, d) => { const days = new Set(rules[i].days || []); if (days.has(d)) days.delete(d); else days.add(d); update(i, { days: [...days].sort() }); };

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Time-based promotions</h3>
          <div className="muted" style={{ fontSize: 13 }}>Automatic % off for appointments that START inside a time window. Applies to online bookings, the chatbot and the till checkout, and prints on the receipt as a discount line.</div>
        </div>
        <button onClick={add}>+ Add promotion</button>
      </div>
      {rules.length === 0 && <div className="muted">No promotions yet.</div>}
      {rules.map((r, i) => (
        <div key={r.id || i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, opacity: r.active === false ? 0.6 : 1 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 2, minWidth: 160 }}><label>Name (shown on receipt)</label><input value={r.name || ''} onChange={(e) => update(i, { name: e.target.value })} placeholder="e.g. Daytime offer" /></div>
            <div style={{ width: 110 }}><label>% off</label><input type="number" min="1" max="100" step="1" value={r.percent ?? ''} onChange={(e) => update(i, { percent: Number(e.target.value) })} /></div>
            <div style={{ width: 130 }}><label>From</label><input type="time" value={r.start || '10:00'} onChange={(e) => update(i, { start: e.target.value })} /></div>
            <div style={{ width: 130 }}><label>Until</label><input type="time" value={r.end || '16:00'} onChange={(e) => update(i, { end: e.target.value })} /></div>
            <div style={{ width: 160 }}><label>Applies to</label>
              <select value={r.channels || 'all'} onChange={(e) => update(i, { channels: e.target.value })}>
                <option value="all">Online + till</option><option value="online">Online only</option><option value="till">Till only</option>
              </select>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>Days:</span>
            {DAY_LABELS.map((d, di) => {
              const everyDay = !r.days || r.days.length === 0;
              const explicit = (r.days || []).includes(di);
              return (
                <button key={d} type="button" onClick={() => toggleDay(i, di)}
                  style={{ padding: '4px 10px', minHeight: 32, fontSize: 12, fontWeight: 700, background: explicit ? 'var(--navy)' : (everyDay ? 'rgba(13,27,62,0.08)' : 'white'), color: explicit ? 'white' : 'var(--navy)' }}>{d}</button>
              );
            })}
            <span className="muted" style={{ fontSize: 11 }}>{(!r.days || r.days.length === 0) ? '(every day — tap a day to restrict)' : ''}</span>
            <span style={{ flex: 1 }} />
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" style={{ width: 18, height: 18, minHeight: 0 }} checked={r.active !== false} onChange={(e) => update(i, { active: e.target.checked })} /> Active
            </label>
            <button className="danger" onClick={() => remove(i)} style={{ fontSize: 12 }}>Remove</button>
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="primary" disabled={busy || !dirty} onClick={() => onSave(JSON.stringify(rules))}>{dirty ? 'Save promotions' : 'Saved'}</button>
        <span className="muted" style={{ fontSize: 12 }}>Based on the appointment's start time (UK). Bookings already made keep the price they were booked at.</span>
      </div>
    </div>
  );
}

function SettingRow({ row, value, busy, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const dirty = v !== value;
  return (
    <div>
      <label>{row.t}</label>
      <div className="row">
        {row.type === 'text'
          ? <input value={v} onChange={(e) => setV(e.target.value)} />
          : <input type={row.type} value={v} onChange={(e) => setV(e.target.value)} />}
        <button className={dirty ? 'primary' : ''} disabled={!dirty || busy} onClick={() => onSave(v)}>
          Save
        </button>
      </div>
    </div>
  );
}
