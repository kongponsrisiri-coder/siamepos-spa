// SPA-COLOR-CODES — let the spa choose the colours used on the Appointments
// timetable. Overrides are stored in settings.timetable_colors as { key: '#hex' }
// (only real overrides are kept); the timetable reads them, falling back to our
// defaults. Categories + defaults mirror apptStyle in AppointmentScreen.jsx.

import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api.js';

const CATEGORIES = [
  { key: 'phone',             label: '📞 Phone booking',      def: '#2563eb' },
  { key: 'walkin',            label: '🚶 Walk-in / staff',    def: '#64748b' },
  { key: 'online',            label: '🌐 Online (website)',   def: '#16a34a' },
  { key: 'treatwell_full',    label: '🅣 Treatwell — prepaid', def: '#0891b2' },
  { key: 'treatwell_partial', label: '🅣 Treatwell — deposit', def: '#f59e0b' },
  { key: 'no_show',           label: '❌ No-show',            def: '#ef4444' },
  { key: 'cancelled',         label: '🚫 Cancelled',          def: '#9ca3af' },
  { key: 'cash',              label: '💵 Paid — cash',        def: '#c2410c' },
  { key: 'card',              label: '💳 Paid — card',        def: '#db2777' },
  { key: 'voucher',           label: '🎁 Paid — voucher',     def: '#7c3aed' },
  { key: 'split',             label: '⇄ Paid — split',        def: '#c026d3' },
];

function hexToRgba(hex, a) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(100,116,139,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function ColorCodesSection() {
  const [colors, setColors] = useState({}); // overrides only: { key: '#hex' }
  const [busy, setBusy]     = useState(false);
  const [saved, setSaved]   = useState(false);

  const load = useCallback(async () => {
    const r = await api.get('/settings');
    const raw = r.settings && r.settings.timetable_colors;
    if (raw) { try { setColors(JSON.parse(raw) || {}); } catch { setColors({}); } }
  }, []);
  useEffect(() => { load(); }, [load]);

  const valueOf = (c) => colors[c.key] || c.def;
  const isCustom = (c) => !!colors[c.key];

  function setColor(key, hex) { setColors((m) => ({ ...m, [key]: hex })); setSaved(false); }
  function resetOne(key) { setColors((m) => { const n = { ...m }; delete n[key]; return n; }); setSaved(false); }

  async function save() {
    setBusy(true);
    try {
      // Keep only genuine overrides (drop any that equal the default).
      const clean = {};
      for (const c of CATEGORIES) {
        const v = colors[c.key];
        if (v && v.toLowerCase() !== c.def.toLowerCase()) clean[c.key] = v;
      }
      await api.put('/settings', { key: 'timetable_colors', value: JSON.stringify(clean) });
      setColors(clean);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } finally { setBusy(false); }
  }

  async function resetAll() {
    if (!confirm('Reset all timetable colours to the defaults?')) return;
    setBusy(true);
    try { await api.put('/settings', { key: 'timetable_colors', value: '{}' }); setColors({}); }
    finally { setBusy(false); }
  }

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Colour Codes</h2>
          <div className="sub">Choose the colours used for appointment blocks on the timetable</div>
        </div>
      </div>

      <div className="card col">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Timetable colours</h3>
          <div className="row">
            <button onClick={resetAll} disabled={busy}>Reset all</button>
            <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Each appointment on the Appointments timetable is coloured by its type below. Pick any
          colour, or leave it as the default. Changes show on the timetable after you save and reopen it.
        </p>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '6px 4px' }}>Sign</th>
              <th style={{ padding: '6px 4px' }}>Preview</th>
              <th style={{ padding: '6px 4px' }}>Colour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((c) => {
              const hex = valueOf(c);
              return (
                <tr key={c.key} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}>{c.label}</td>
                  <td style={{ padding: '8px 4px' }}>
                    <span style={{
                      display: 'inline-block', padding: '3px 12px', borderRadius: 6,
                      background: hexToRgba(hex, 0.15), border: `1px solid ${hex}`, color: hex,
                      fontWeight: 600, fontSize: 12,
                    }}>
                      {c.label.replace(/^\S+\s/, '')}
                    </span>
                  </td>
                  <td style={{ padding: '8px 4px', whiteSpace: 'nowrap' }}>
                    <input
                      type="color" value={hex}
                      onChange={(e) => setColor(c.key, e.target.value)}
                      style={{ width: 44, height: 30, padding: 0, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', verticalAlign: 'middle' }}
                    />
                    <span style={{ fontFamily: 'monospace', fontSize: 12, marginLeft: 8, color: 'var(--muted)' }}>{hex}</span>
                  </td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                    {isCustom(c) && <button onClick={() => resetOne(c.key)} style={{ fontSize: 12 }}>Reset</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
