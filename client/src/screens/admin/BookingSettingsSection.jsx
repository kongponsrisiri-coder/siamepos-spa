import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const KEYS = [
  { k: 'opening_time',             t: 'Opening time',                            type: 'time'   },
  { k: 'closing_time',             t: 'Closing time',                            type: 'time'   },
  { k: 'booking_slot_minutes',     t: 'Slot size (minutes)',                     type: 'number' },
  { k: 'booking_advance_days',     t: 'Advance booking window (days)',           type: 'number' },
  { k: 'cancellation_policy_text', t: 'Cancellation policy (shown on widget)',   type: 'text'   },
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
