import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';
import { BRAND_PRESETS, DEFAULT_PRIMARY, DEFAULT_ACCENT, applyBrandTheme } from '../../theme.js'; // SPA-BRAND-001

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

      <BrandingCard settings={settings} save={save} busy={busy} />

      <LoyaltyCard settings={settings} save={save} busy={busy} />

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

// ── Branding (SPA-BRAND-001) ────────────────────────────────────────
// Per-spa white-label: logo, colours + login logo size. Saves each key to the
// settings table (same PUT /settings the identity fields use). Colour changes
// call applyBrandTheme for a live preview across the app.
const bLbl = { display: 'block', fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 6 };
const bColor = { width: 52, height: 40, border: '1px solid #ddd', borderRadius: 8, cursor: 'pointer', background: 'none' };

function BrandingCard({ settings, save, busy }) {
  const primary  = settings.brand_primary   || DEFAULT_PRIMARY;
  const accent   = settings.brand_accent    || DEFAULT_ACCENT;
  const logoSize = settings.brand_logo_size || 'large';

  function onLogo(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { alert('Logo is too large — please use an image under 1 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => save('brand_logo', String(reader.result));
    reader.readAsDataURL(file);
  }
  function pickPreset(p) {
    save('brand_primary', p.primary);
    save('brand_accent', p.accent);
    applyBrandTheme({ brand_primary: p.primary, brand_accent: p.accent });
  }
  function setColour(key, val) {
    save(key, val);
    applyBrandTheme({ brand_primary: key === 'brand_primary' ? val : primary, brand_accent: key === 'brand_accent' ? val : accent });
  }

  return (
    <div className="card col">
      <h3 style={{ margin: 0 }}>Branding</h3>
      <div className="sub" style={{ marginBottom: 8 }}>Your logo, colours + login name — makes the till feel like your spa. The login-screen name is the “Spa name” above.</div>

      <label style={bLbl}>App logo (login &amp; headers)</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <div style={{ width: 80, height: 80, borderRadius: 12, background: primary, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          {settings.brand_logo
            ? <img src={settings.brand_logo} alt="" style={{ maxWidth: '86%', maxHeight: '86%', objectFit: 'contain' }} />
            : <span style={{ color: '#fff', opacity: 0.5, fontSize: 11 }}>no logo</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--navy)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            📁 Choose logo
            <input type="file" accept="image/*" onChange={onLogo} disabled={busy} style={{ display: 'none' }} />
          </label>
          {settings.brand_logo && <button onClick={() => save('brand_logo', '')} disabled={busy} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#fee2e2', color: '#ef4444', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>🗑 Remove</button>}
        </div>
      </div>

      <label style={bLbl}>App logo size</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xl', 'Extra Large']].map(([val, label]) => (
          <button key={val} onClick={() => save('brand_logo_size', val)} disabled={busy} style={{
            padding: '7px 15px', borderRadius: 8, border: '2px solid', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            borderColor: logoSize === val ? 'var(--navy)' : '#ddd', background: logoSize === val ? 'var(--navy)' : '#fff', color: logoSize === val ? '#fff' : '#555',
          }}>{label}</button>
        ))}
      </div>

      <label style={bLbl}>Colour theme</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {BRAND_PRESETS.map((p) => {
          const active = primary.toLowerCase() === p.primary.toLowerCase() && accent.toLowerCase() === p.accent.toLowerCase();
          return (
            <button key={p.name} title={p.name} onClick={() => pickPreset(p)} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 9px', borderRadius: 8, border: `2px solid ${active ? 'var(--navy)' : '#e5e5e5'}`, background: '#fff', cursor: 'pointer' }}>
              <span style={{ width: 15, height: 15, borderRadius: 4, background: p.primary }} />
              <span style={{ width: 15, height: 15, borderRadius: 4, background: p.accent }} />
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div><label style={bLbl}>Primary</label><input type="color" value={primary} onChange={(e) => setColour('brand_primary', e.target.value)} style={bColor} /></div>
        <div><label style={bLbl}>Accent</label><input type="color" value={accent} onChange={(e) => setColour('brand_accent', e.target.value)} style={bColor} /></div>
      </div>
    </div>
  );
}

// ── Loyalty card (SPA-LOYALTY-001) ─────────────────────────────────
// "Every Nth visit free", auto-counted from paid bills on DIRECT bookings
// (Treatwell/Fresha visits never earn — that's the channel-shift point).
// The reward ladder is fully spa-configurable: any number of tiers, each
// "at visit N → reward", with an optional £ value that auto-applies as a
// bill discount when redeemed at checkout.
function LoyaltyCard({ settings, save, busy }) {
  const enabled = settings.loyalty_enabled === '1' || settings.loyalty_enabled === 'true';
  const repeat = settings.loyalty_repeat_after_last == null
    ? true
    : (settings.loyalty_repeat_after_last === '1' || settings.loyalty_repeat_after_last === 'true');

  const [tiers, setTiers] = useState([]);
  const [tiersDirty, setTiersDirty] = useState(false);
  const [minSpend, setMinSpend] = useState('');
  const [terms, setTerms] = useState('');

  useEffect(() => {
    try {
      const parsed = JSON.parse(settings.loyalty_tiers || '[]');
      setTiers(Array.isArray(parsed) ? parsed.map((t) => ({
        at_visit: t.at_visit ?? '', reward: t.reward ?? '', value: t.value ?? '',
      })) : []);
    } catch { setTiers([]); }
    setTiersDirty(false);
  }, [settings.loyalty_tiers]);
  useEffect(() => { setMinSpend(settings.loyalty_min_spend ?? ''); }, [settings.loyalty_min_spend]);
  useEffect(() => { setTerms(settings.loyalty_terms ?? ''); }, [settings.loyalty_terms]);

  const setTier = (i, k, v) => { setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, [k]: v } : t))); setTiersDirty(true); };
  const addTier = () => { setTiers((ts) => [...ts, { at_visit: '', reward: '', value: '' }]); setTiersDirty(true); };
  const removeTier = (i) => { setTiers((ts) => ts.filter((_, j) => j !== i)); setTiersDirty(true); };

  async function saveTiers() {
    const clean = tiers
      .map((t) => ({
        at_visit: Math.trunc(Number(t.at_visit)),
        reward: String(t.reward || '').trim(),
        ...(t.value !== '' && isFinite(Number(t.value)) && Number(t.value) > 0
          ? { value: +Number(t.value).toFixed(2) } : {}),
      }))
      .filter((t) => Number.isFinite(t.at_visit) && t.at_visit > 0 && t.reward)
      .sort((a, b) => a.at_visit - b.at_visit);
    await save('loyalty_tiers', JSON.stringify(clean));
    setTiersDirty(false);
  }

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>⭐ Loyalty card</h3>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={enabled}
            disabled={busy} onChange={(e) => save('loyalty_enabled', e.target.checked ? '1' : '0')} />
          <span style={{ fontWeight: 600 }}>{enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <div className="sub" style={{ marginTop: -6 }}>
        Visits count automatically when a bill is paid — direct bookings only (Treatwell/Fresha
        visits don't earn, so regulars have a reason to book with you directly). Customers get a
        progress email after each visit and can keep the card in Apple Wallet.
      </div>

      <label style={bLbl}>Reward ladder — "at visit N, the customer gets…"</label>
      {tiers.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No rewards yet — add your first tier below (e.g. visit 5 → free hot-oil upgrade, visit 10 → free 60-min massage).</div>}
      {tiers.map((t, i) => (
        <div key={i} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>Visit</span>
          <input type="number" min="1" value={t.at_visit} onChange={(e) => setTier(i, 'at_visit', e.target.value)}
            style={{ width: 70 }} placeholder="10" />
          <input value={t.reward} onChange={(e) => setTier(i, 'reward', e.target.value)}
            style={{ flex: 1, minWidth: 160 }} placeholder="Reward (e.g. Free 60-min massage)" />
          <span className="muted" style={{ fontSize: 13 }}>£ off (optional)</span>
          <input type="number" min="0" step="0.01" value={t.value} onChange={(e) => setTier(i, 'value', e.target.value)}
            style={{ width: 90 }} placeholder="auto" title="If set, this £ amount is applied to the bill automatically when the reward is redeemed at checkout" />
          <button onClick={() => removeTier(i)} disabled={busy}
            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}>✕</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button onClick={addTier} disabled={busy}>＋ Add tier</button>
        {tiersDirty && <button className="primary" onClick={saveTiers} disabled={busy}>Save ladder</button>}
      </div>

      <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
        <div>
          <label style={bLbl}>Minimum spend for a visit to count (£)</label>
          <div className="row">
            <input type="number" min="0" step="0.01" value={minSpend}
              onChange={(e) => setMinSpend(e.target.value)} style={{ width: 110 }} placeholder="0" />
            <button disabled={busy || String(minSpend) === String(settings.loyalty_min_spend ?? '')}
              onClick={() => save('loyalty_min_spend', String(Number(minSpend) || 0))}>Save</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>Stops a £5 add-on counting as a full visit. Based on the bill's list value, so a free reward visit still counts.</div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', paddingBottom: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={repeat}
            disabled={busy} onChange={(e) => save('loyalty_repeat_after_last', e.target.checked ? '1' : '0')} />
          <span>Start a fresh card after the last reward (classic punch-card)</span>
        </label>
      </div>

      {/* Per-spa T&Cs — shown on the back of the Apple Wallet card and in the
          progress-email footer. One clause per line reads best. */}
      <div style={{ marginTop: 10 }}>
        <label style={bLbl}>Terms &amp; conditions (shown on the Wallet card + emails)</label>
        <textarea rows={7} value={terms} onChange={(e) => setTerms(e.target.value)}
          placeholder={'1. Validity: …\n2. Earning stamps: …\n3. Non-transferable: …'}
          style={{ width: '100%', fontSize: 13, lineHeight: 1.5 }} disabled={busy} />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 11 }}>Leave empty to show no terms. Customers with the card in Apple Wallet see the new text automatically.</span>
          {String(terms) !== String(settings.loyalty_terms ?? '') && (
            <button className="primary" disabled={busy} onClick={() => save('loyalty_terms', terms.trim())}>Save terms</button>
          )}
        </div>
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
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => { setV(value); }, [value]);
  const dirty = v !== value;

  // Foolproof save: commit when the field loses focus (click away) OR on Enter,
  // as well as the explicit Save button — so a typed value (e.g. the Spa name
  // that shows on the login) can't be left uncommitted. A "Saved" flash makes
  // it obvious it persisted.
  async function commit() {
    if (!dirty || busy) return;
    await onSave(v);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }

  return (
    <div>
      <label>{row.t}</label>
      <div className="row">
        <input
          value={v}
          onChange={(e) => { setV(e.target.value); setJustSaved(false); }}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        />
        <button className={dirty ? 'primary' : ''} disabled={!dirty || busy} onClick={commit}
          style={(!dirty && justSaved) ? { color: '#15803d', borderColor: '#15803d' } : undefined}>
          {(!dirty && justSaved) ? '✓ Saved' : 'Save'}
        </button>
      </div>
      {dirty
        ? <div style={{ fontSize: 11, color: '#b45309', marginTop: 3 }}>Unsaved — click away or press Enter to save</div>
        : (justSaved ? <div style={{ fontSize: 11, color: '#15803d', marginTop: 3 }}>✓ Saved</div> : null)}
    </div>
  );
}
