// SPA-ANDROID-001 — Admin → Mobile App.
//
// One link, forever: /app always redirects to the current APK, so a shop can
// bookmark it, scan the QR from another tablet, or send it to a new member of
// staff without anyone chasing a version number. When the till is already
// running inside the app, this page also says whether an update is waiting.
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, apiBase } from '../../api.js';
import { APP_BUILD, isNativeApp, isNewer } from '../../appBuild.js';
import LineConnectCard from './LineConnectCard.jsx'; // SPA-LINE-WHERE-001

export default function MobileAppSection() {
  const [info, setInfo]   = useState(null);
  const [qr, setQr]       = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const inApp = isNativeApp();

  useEffect(() => {
    api.get('/app/android')
      .then((r) => {
        setInfo(r);
        return QRCode.toDataURL(r.download_url, { width: 320, margin: 1 });
      })
      .then((d) => d && setQr(d))
      .catch(() => setError('Could not reach the spa to check the app version. Try again in a moment.'));
  }, []);

  const link = info?.download_url || `${apiBase()}/app`;
  const updateWaiting = inApp && isNewer(info?.version, APP_BUILD);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { window.prompt?.('Copy this link:', link); }
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="section-header">
        <div>
          <h2>Mobile App</h2>
          <div className="sub">The SiamEPOS Spa app for Android tablets and phones</div>
        </div>
      </div>

      {error && <div className="card" style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b' }}>{error}</div>}

      {/* Update status — only meaningful inside the app */}
      {inApp && (
        <div className="card col" style={{
          gap: 8,
          background: updateWaiting ? '#fffbeb' : '#f0fdf4',
          border: `1px solid ${updateWaiting ? '#f59e0b' : '#86efac'}`,
        }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: updateWaiting ? '#92400e' : '#166534' }}>
            {updateWaiting ? `Update available — version ${info.version}` : 'You are on the latest version'}
          </div>
          <div style={{ fontSize: 13, color: updateWaiting ? '#92400e' : '#166534' }}>
            Installed: {APP_BUILD || 'unknown'}{info?.version ? ` · Latest: ${info.version}` : ''}
          </div>
          {updateWaiting && (
            <>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <a href={link}><button className="primary" style={{ minHeight: 46, fontWeight: 800 }}>Download the update</button></a>
                {info?.notes_url && <a href={info.notes_url} target="_blank" rel="noreferrer"><button style={{ minHeight: 46 }}>What&rsquo;s new</button></a>}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                The file downloads, then tap it to install over the current app. Nothing is lost: the tablet keeps this spa and your login.
              </div>
            </>
          )}
        </div>
      )}

      {/* SPA-PUSH-001 — booking notifications */}
      <PushPanel inApp={inApp} />

      {/* SPA-LINE-WHERE-001 — owners come here looking for the LINE switch, so
          the Connect card sits right under it as well as under Settings. */}
      <LineConnectCard selfLoad />

      {/* SPA-DEVICE-PAIR-001 — inviting a tablet, right next to the download. */}
      <PairTabletCard />

      {/* The link itself */}
      <div className="card" style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {qr && (
          <div style={{ textAlign: 'center' }}>
            <img src={qr} alt="QR code to download the app" width={160} height={160}
              style={{ border: '1px solid var(--border)', borderRadius: 8, display: 'block' }} />
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Scan with the tablet</div>
          </div>
        )}
        <div className="col" style={{ flex: 1, minWidth: 260, gap: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>Install on another device</h3>
            <div className="muted" style={{ fontSize: 13 }}>
              This link never changes. It always gives the current version{info?.version ? ` (${info.version} today)` : ''},
              so you can bookmark it or send it to staff.
            </div>
          </div>
          <input readOnly value={link} onFocus={(e) => e.target.select()} style={{ fontSize: 13 }} />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" onClick={copy}>{copied ? '✓ Copied' : '📋 Copy link'}</button>
            <a href={link}><button>Download now</button></a>
            {info?.notes_url && <a href={info.notes_url} target="_blank" rel="noreferrer"><button>What&rsquo;s new</button></a>}
          </div>
        </div>
      </div>

      {/* How to install */}
      <div className="card col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Setting up a new tablet</h3>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
          <li>Open the link above on the tablet, or scan the QR code with its camera.</li>
          <li>Let the file download, then tap it. Android asks permission to install apps from your browser — that is normal for an app outside the Play Store, and you only grant it once.</li>
          <li>Open the app. It asks which spa this tablet belongs to. Choose yours.</li>
          <li>Sign in the usual way: tap your name and enter your PIN.</li>
        </ol>
        <div className="muted" style={{ fontSize: 12 }}>
          Updates work the same way: open the link, download, tap. Installing over the app keeps your spa and your login.
          iPhones and iPads are not supported yet — they can use the till in Safari as before.
        </div>
      </div>
    </div>
  );
}

// ── SPA-PUSH-001 — booking notifications ────────────────────────────────────
function PushPanel({ inApp }) {
  const [status, setStatus] = useState(null);   // { configured }
  const [busy, setBusy]     = useState(false);
  const [msg, setMsg]       = useState('');

  useEffect(() => { api.get('/push/status').then(setStatus).catch(() => setStatus({ configured: false })); }, []);

  async function test() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/push/test', {});
      setMsg(r.skipped
        ? `Not sent: ${r.reason}`
        : r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}. Check the tablet.`
          : 'No devices are registered yet — open the app on a tablet and sign in.');
    } catch (e) { setMsg(e.message || 'Could not send'); }
    finally { setBusy(false); }
  }

  if (!status) return null;
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div>
        <h3 style={{ margin: 0 }}>Booking notifications</h3>
        <div className="muted" style={{ fontSize: 13 }}>
          Alerts for bookings that arrive from the website, Treatwell, Fresha or the chatbot.
          Bookings typed at the till stay silent.
        </div>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Channel on={status.line} title="LINE message to your phone"
          desc="Reaches you anywhere, with or without the app. Nothing to install." />
        <Channel on={status.configured} title="Notification on the shop tablet"
          desc="The tablet buzzes even when the app is closed." />
      </div>
      {(status.line || status.configured) ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={test} disabled={busy}>{busy ? 'Sending…' : '🔔 Send a test alert'}</button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Ask SiamEPOS to switch these on — it takes one setting on your cloud.
        </div>
      )}
    </div>
  );
}

function Channel({ on, title, desc }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: on ? '#f0fdf4' : '#f8fafc', border: `1px solid ${on ? '#86efac' : 'var(--border)'}` }}>
      <span style={{ fontSize: 15, lineHeight: 1.2 }}>{on ? '✅' : '⚪️'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12 }}>{desc}</div>
      </div>
      <span style={{ fontSize: 11, fontWeight: 800, color: on ? '#166534' : '#94a3b8' }}>{on ? 'On' : 'Off'}</span>
    </div>
  );
}

// ── SPA-DEVICE-PAIR-001 — invite a tablet to THIS spa ───────────────────────
// The app no longer lists our clients on its first screen: anyone who
// downloaded it could tap a real shop and reach its till. A tablet now has to
// be invited from inside the spa, by someone signed in as an admin.
function PairTabletCard() {
  const [code, setCode] = useState(null);   // { code, expires_in_minutes }
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');
  const [left, setLeft] = useState(0);      // seconds remaining

  useEffect(() => {
    if (!code) return undefined;
    const until = Date.now() + (code.expires_in_minutes || 15) * 60000;
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { clearInterval(t); setCode(null); }
    }, 1000);
    return () => clearInterval(t);
  }, [code]);

  async function make() {
    setBusy(true); setErr('');
    try { setCode(await api.post('/devices/pair/start', {})); }
    catch (e) { setErr(e.message || 'Could not create a setup code'); }
    finally { setBusy(false); }
  }

  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    <div className="card col" style={{ gap: 10 }}>
      <div>
        <h3 style={{ margin: 0 }}>Pair a new tablet</h3>
        <div className="muted" style={{ fontSize: 13 }}>
          A tablet can only join this spa with a code from here, so nobody who
          downloads the app can reach your till.
        </div>
      </div>

      {code ? (
        <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 13, color: '#92400e', marginBottom: 6 }}>
            On the new tablet, open the app and type this code:
          </div>
          <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: '0.22em', color: '#0D1B3E', textAlign: 'center', padding: '6px 0' }}>
            {code.code}
          </div>
          <div style={{ fontSize: 12, color: '#92400e', textAlign: 'center' }}>
            Expires in {mmss} · works once
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="primary" onClick={make} disabled={busy}>
            {busy ? 'Creating…' : 'Create a setup code'}
          </button>
          {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        </div>
      )}

      {code && (
        <div className="row" style={{ gap: 8 }}>
          <button onClick={make} disabled={busy}>New code</button>
          <button onClick={() => setCode(null)}>Done</button>
        </div>
      )}
    </div>
  );
}
