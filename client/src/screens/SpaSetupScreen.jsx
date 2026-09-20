// SPA-DEVICE-PAIR-001 — first run: which spa does this tablet belong to?
//
// It used to answer that with a list of our clients by name. One APK serves
// every shop and the download link is public, so that list was a directory of
// who our clients are AND a one-tap route to a real shop's till for anyone who
// installed the app. A PIN still stood in the way, but the front door should
// not be open at all.
//
// Now the tablet has to be invited: someone signed in as an admin at the spa
// opens Admin → Mobile App → "Pair a new tablet" and reads out a six-character
// code. The code is redeemed at the pairing service, which returns that spa's
// address. Codes last 15 minutes and work once.
import React, { useState } from 'react';
import { setApiBase, PAIR_BROKER } from '../apiBase.js';
import { NAVY, GOLD } from '../theme.js';

export default function SpaSetupScreen({ onDone }) {
  const [code, setCode]   = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [spa, setSpa]     = useState('');
  // SPA-DEVICE-PAIR-002 — the way back in. A code can only be minted by someone
  // ALREADY signed in at the spa, so a shop whose only tablet lost its address
  // has no way to produce one: locked out by the thing meant to protect them.
  // Typing the address is not the hole the client LIST was — the address is
  // public (it is in every web till's bundle) and a PIN still stands in the way.
  const [manual, setManual] = useState(false);
  const [addr, setAddr]     = useState('');

  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  async function submit() {
    if (clean.length !== 6 || busy) return;
    setBusy(true); setError(''); setSpa('');
    try {
      const res = await fetch(`${PAIR_BROKER}/device-pair/${clean}`, { signal: AbortSignal.timeout(15000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The pairing service answered ${res.status}`);
      if (!data.api_base) throw new Error('That code did not come with a spa address.');

      // Prove the spa answers before committing the tablet to it — a dead
      // address here would otherwise look like "the app is broken" on the floor.
      const health = await fetch(`${data.api_base}/api/health`, { signal: AbortSignal.timeout(15000) });
      const ok = health.ok && (await health.json().catch(() => ({}))).ok;
      if (!ok) throw new Error('Found the spa, but it did not answer. Check the tablet is online and try again.');

      setSpa(data.spa || '');
      setApiBase(data.api_base);
      setTimeout(() => onDone && onDone(), 700);   // let them see which spa it found
    } catch (e) {
      setError(
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'No answer — check the tablet is online, then try again.'
          : (e.message || 'Could not set this tablet up.'),
      );
      setBusy(false);
    }
  }

  async function useAddress() {
    const clean = addr.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/i.test(clean)) { setError('That address should start with https://'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(`${clean}/api/health`, { signal: AbortSignal.timeout(15000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error('That address did not answer as a SiamEPOS Spa.');
      setApiBase(clean);
      onDone && onDone();
    } catch (e) {
      setError(e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'No answer — check the tablet is online, then try again.'
        : (e.message || 'Could not connect.'));
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100dvh', background: NAVY, color: 'white', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ width: 'min(100%, 420px)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ textAlign: 'center', marginBottom: 6 }}>
          <div style={{ color: GOLD, fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700 }}>
            SiamEPOS Spa
          </div>
          <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 26, margin: '6px 0 4px', color: 'white' }}>
            Set this tablet up
          </h1>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 1.5 }}>
            Enter the setup code from your till:<br />
            <strong style={{ color: 'white' }}>Admin &rarr; Mobile App &rarr; Pair a new tablet</strong>
          </div>
        </div>

        <input
          value={clean}
          onChange={(e) => { setCode(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="ABC123"
          autoCapitalize="characters" autoCorrect="off" spellCheck="false"
          inputMode="text" autoFocus
          style={{
            background: 'rgba(255,255,255,0.10)', color: 'white',
            border: '1px solid rgba(255,255,255,0.3)', borderRadius: 12,
            textAlign: 'center', fontSize: 30, fontWeight: 800,
            letterSpacing: '0.25em', padding: '14px 10px', width: '100%',
          }}
        />

        <button
          className="primary"
          disabled={busy || clean.length !== 6}
          onClick={submit}
          style={{
            width: '100%', minHeight: 52, border: 'none', borderRadius: 12,
            background: clean.length === 6 && !busy ? GOLD : 'rgba(255,255,255,0.15)',
            color: clean.length === 6 && !busy ? NAVY : 'rgba(255,255,255,0.5)',
            fontWeight: 800, fontSize: 16,
          }}
        >{busy ? 'Checking…' : 'Connect'}</button>

        {spa && (
          <div style={{ background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(134,239,172,0.5)', color: '#bbf7d0', borderRadius: 10, padding: '10px 14px', fontSize: 14, textAlign: 'center' }}>
            ✅ Connected to <strong>{spa}</strong>
          </div>
        )}

        {error && (
          <div style={{ background: 'rgba(220,38,38,0.18)', border: '1px solid rgba(248,113,113,0.5)', color: '#fecaca', borderRadius: 10, padding: '10px 14px', fontSize: 14 }}>
            {error}
          </div>
        )}

        {manual ? (
          <div style={{ marginTop: 4 }}>
            <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
              Your spa's address
            </label>
            <input
              value={addr}
              onChange={(e) => { setAddr(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') useAddress(); }}
              placeholder="https://your-spa.up.railway.app"
              autoCapitalize="none" autoCorrect="off" spellCheck="false" inputMode="url"
              style={{ marginTop: 6, width: '100%', background: 'rgba(255,255,255,0.10)', color: 'white',
                border: '1px solid rgba(255,255,255,0.3)', borderRadius: 10, padding: '12px 14px', fontSize: 15 }}
            />
            <button onClick={useAddress} disabled={busy || !addr.trim()}
              style={{ marginTop: 8, width: '100%', minHeight: 48, border: 'none', borderRadius: 10,
                background: 'rgba(255,255,255,0.15)', color: 'white', fontWeight: 700, fontSize: 15 }}
            >{busy ? 'Checking…' : 'Connect with this address'}</button>
          </div>
        ) : (
          <button onClick={() => { setManual(true); setError(''); }}
            style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)',
              fontSize: 13, textDecoration: 'underline', cursor: 'pointer', marginTop: 2 }}
          >No code? Use your spa&rsquo;s address instead</button>
        )}

        <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, textAlign: 'center', marginTop: 4, lineHeight: 1.6 }}>
          A code lasts 15 minutes and works once.<br />
          Stuck? Ask SiamEPOS — info@siamepos.co.uk
        </div>
      </div>
    </div>
  );
}
