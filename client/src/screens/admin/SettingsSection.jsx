import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const KEYS = [
  { k: 'spa_name',  t: 'Spa name'   },
  { k: 'spa_email', t: 'Spa email'  },
];

export default function SettingsSection() {
  const [settings, setSettings] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get('/settings');
    setSettings(r.settings);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(k, v) {
    setBusy(true);
    try {
      await api.put('/settings', { key: k, value: v });
      setSettings((s) => ({ ...s, [k]: v }));
    } finally { setBusy(false); }
  }

  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Spa identity</h3>
        {KEYS.map((row) => (
          <Row key={row.k} row={row} value={settings[row.k] ?? ''} busy={busy} onSave={(v) => save(row.k, v)} />
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Payment keys</h3>
        <p className="muted">
          Stripe and Brevo API keys are set as Railway environment variables — they are not
          editable here for security. See <code>.env.example</code> in the backend repo for
          the full list (<code>STRIPE_SECRET_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code>,
          <code>BREVO_API_KEY</code>, <code>JWT_SECRET</code>).
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Public booking widget</h3>
        <p className="muted">
          The embed snippets for your website live under the <strong>Embed Codes</strong> tab.
        </p>
      </div>
    </div>
  );
}

function Row({ row, value, busy, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const dirty = v !== value;
  return (
    <div>
      <label>{row.t}</label>
      <div className="row">
        <input value={v} onChange={(e) => setV(e.target.value)} />
        <button className={dirty ? 'primary' : ''} disabled={!dirty || busy} onClick={() => onSave(v)}>Save</button>
      </div>
    </div>
  );
}
