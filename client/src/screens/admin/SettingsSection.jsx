import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const KEYS = [
  { k: 'spa_name',         t: 'Spa name'   },
  { k: 'spa_email',        t: 'Spa email'  },
  { k: 'owner_email',      t: 'Owner login email (for the Owner login magic link)' },
  // Business details — appear on the VAT receipt (Bills → Receipt).
  { k: 'legal_name',       t: 'Registered business name (for receipts)' },
  { k: 'business_address', t: 'Business address (for receipts)' },
  { k: 'business_phone',   t: 'Business phone (for receipts)' },
  { k: 'vat_number',       t: 'VAT number (leave blank if not VAT registered)' },
  { k: 'company_number',   t: 'Company number (optional)' },
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
      <div className="section-header">
        <div>
          <h2>Settings</h2>
          <div className="sub">Spa identity and system configuration</div>
        </div>
      </div>
      <div className="card col">
        <h3 style={{ margin: 0 }}>Spa identity</h3>
        {KEYS.map((row) => (
          <Row key={row.k} row={row} value={settings[row.k] ?? ''} busy={busy} onSave={(v) => save(row.k, v)} />
        ))}
      </div>

      <AppUpdatesCard />

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

// ── App & Updates ──────────────────────────────────────────────────
// Desktop till only. The app auto-updates in the background (now also on an
// hourly timer, not just at launch); this card shows the running version and
// lets staff trigger a check on demand — mirrors the restaurant EPOS pattern.
const sp = (typeof window !== 'undefined' && window.siamposSpa) || null;
const native = !!(sp && sp.isElectron);

function statusMsg(s) {
  switch (s && s.state) {
    case 'checking':  return { text: 'Checking for updates…', tone: 'muted' };
    case 'available': return { text: `Update ${s.version ? 'v' + s.version : ''} found — downloading…`, tone: 'muted' };
    case 'none':      return { text: "You're on the latest version.", tone: 'ok' };
    case 'ready':     return { text: 'Update downloaded — restart to apply it.', tone: 'ok' };
    case 'error':     return { text: 'Last update check failed.', tone: 'err' };
    default:          return null;
  }
}

function AppUpdatesCard() {
  const [version, setVersion] = useState('');
  const [status, setStatus]   = useState(null); // { text, tone }
  const [ready, setReady]     = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!native) return;
    sp.getAppVersion().then(setVersion).catch(() => {});
    sp.getUpdateStatus().then((s) => {
      if (s && s.state === 'ready') setReady(true);
      const m = statusMsg(s); if (m) setStatus(m);
    }).catch(() => {});

    const offs = [
      sp.onUpdate('checking', () => { setChecking(true); setStatus({ text: 'Checking for updates…', tone: 'muted' }); }),
      sp.onUpdate('available', (v) => setStatus({ text: `Update ${v ? 'v' + v : ''} found — downloading…`, tone: 'muted' })),
      sp.onUpdate('progress', (p) => setStatus({ text: `Downloading update… ${p ?? 0}%`, tone: 'muted' })),
      sp.onUpdate('none', () => { setChecking(false); setStatus({ text: "You're on the latest version.", tone: 'ok' }); }),
      sp.onUpdate('error', (m) => { setChecking(false); setStatus({ text: `Update check failed: ${m || 'unknown error'}`, tone: 'err' }); }),
      sp.onUpdate('ready', () => { setChecking(false); setReady(true); setStatus({ text: 'Update downloaded — restart to apply it.', tone: 'ok' }); }),
    ];
    return () => offs.forEach((off) => off && off());
  }, []);

  if (!native) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>⬆️ App &amp; Updates</h3>
        <p className="muted">
          Auto-update applies to the installed desktop till app. You're viewing the web version,
          which always runs the latest automatically.
        </p>
      </div>
    );
  }

  async function check() {
    setChecking(true);
    setStatus({ text: 'Checking for updates…', tone: 'muted' });
    try {
      const r = await sp.checkForUpdates();
      if (r && !r.ok) {
        setChecking(false);
        setStatus({ text: r.reason === 'dev' ? 'Updates are disabled in development.' : `Update check failed: ${r.reason}`, tone: 'err' });
      }
    } catch (e) {
      setChecking(false);
      setStatus({ text: `Update check failed: ${e}`, tone: 'err' });
    }
  }

  const toneColor = status && (status.tone === 'err' ? '#b91c1c' : status.tone === 'ok' ? '#166534' : undefined);

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>⬆️ App &amp; Updates</h3>
        <span style={{ background: '#dcfce7', color: '#166534', fontWeight: 700, fontSize: 12, padding: '2px 10px', borderRadius: 999 }}>
          🟢 v{version || '…'}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        SiamEPOS Spa keeps itself up to date automatically — new versions download quietly in the
        background and apply when you restart. You don't need to do anything; this is just so you can
        see what's running and check on demand.
      </p>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Installed version</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>v{version || '—'}</div>
        </div>
        {ready ? (
          <button className="primary" onClick={() => sp.quitAndInstall()}>↻ Restart &amp; update</button>
        ) : (
          <button onClick={check} disabled={checking}>{checking ? 'Checking…' : '🔄 Check for updates'}</button>
        )}
      </div>
      {status && (
        <div style={{ fontSize: 13, color: toneColor }} className={toneColor ? '' : 'muted'}>{status.text}</div>
      )}
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
