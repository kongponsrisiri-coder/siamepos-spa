import React, { useState } from 'react';
import { getStaff } from '../api.js';

import TradingSection         from './admin/TradingSection.jsx';
import ReportsSection         from './admin/ReportsSection.jsx';
import ZReportSection         from './admin/ZReportSection.jsx';
import TreatmentMenuSection   from './admin/TreatmentMenuSection.jsx';
import TherapistSection       from './admin/TherapistSection.jsx';
import RoomSection            from './admin/RoomSection.jsx';
import BookingSettingsSection from './admin/BookingSettingsSection.jsx';
import EmbedCodesSection      from './admin/EmbedCodesSection.jsx';
import SettingsSection        from './admin/SettingsSection.jsx';
import RotaSection            from './admin/RotaSection.jsx';
import BillsSection           from './admin/BillsSection.jsx';
import VouchersSection        from './admin/VouchersSection.jsx';
import ClientsSection         from './admin/ClientsSection.jsx';

// ── Sandy: AdminScreen — left sidebar, matches EPOS admin layout ──
// Slate Navy #1e3a6e sidebar · Thai Gold #C9A84C active state

const NAV = [
  { k: 'trading',    label: '📊 Trading' },
  { k: 'reports',    label: '📈 Reports' },
  { k: 'zreport',    label: '🔐 Z Report' },
  { k: 'bills',      label: '🧾 Bills' },
  { k: 'clients',    label: '👤 Clients' },
  { k: 'vouchers',   label: '🎁 Vouchers' },
  { k: 'menu',       label: '💆 Treatments' },
  { k: 'therapists', label: '👥 Therapists' },
  { k: 'rota',       label: '📅 Rota' },
  { k: 'rooms',      label: '🛁 Rooms' },
  { k: 'booking',    label: '⚙️ Booking' },
  { k: 'embed',      label: '🔗 Embed Codes' },
  { k: 'settings',   label: '🔧 Settings' },
];

const SECTIONS = {
  trading:    TradingSection,
  reports:    ReportsSection,
  zreport:    ZReportSection,
  bills:      BillsSection,
  clients:    ClientsSection,
  vouchers:   VouchersSection,
  menu:       TreatmentMenuSection,
  therapists: TherapistSection,
  rota:       RotaSection,
  rooms:      RoomSection,
  booking:    BookingSettingsSection,
  embed:      EmbedCodesSection,
  settings:   SettingsSection,
};

export default function AdminScreen() {
  const [tab, setTab] = useState('trading');
  const staff = getStaff();

  if (!staff || !['admin', 'manager'].includes(staff.role)) {
    return (
      <div style={{ padding: 32 }}>
        <div className="card">
          <h2>Admin</h2>
          <p className="muted">Admin or manager role required.</p>
        </div>
      </div>
    );
  }

  const Current = SECTIONS[tab] || TradingSection;

  return (
    <div style={{
      display: 'flex',
      height: 'calc(100vh - 52px)',       /* 52px = TopNav height */
      margin: '-20px -20px 0',            /* undo AppShell's 20px top + side padding */
      width: 'calc(100% + 40px)',         /* stretch to fill the undone padding */
    }}>

      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside style={{
        width: 200,
        background: '#1e3a6e',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 0',
        flexShrink: 0,
        boxShadow: '2px 0 8px rgba(14,28,55,0.18)',
      }}>
        <div style={{
          color: 'rgba(201,168,76,0.55)',
          fontWeight: 700,
          fontSize: 11,
          padding: '0 20px 16px',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontFamily: 'Inter, sans-serif',
        }}>
          Admin Panel
        </div>

        {NAV.map(({ k, label }) => {
          const active = tab === k;
          return (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                background: active ? 'rgba(201,168,76,0.15)' : 'none',
                border: 'none',
                borderLeft: active ? '3px solid #C9A84C' : '3px solid transparent',
                color: active ? '#C9A84C' : 'rgba(255,255,255,0.72)',
                padding: '11px 20px',
                paddingLeft: active ? 17 : 17,   /* consistent left pad with border */
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 13.5,
                fontWeight: active ? 600 : 400,
                fontFamily: 'Inter, sans-serif',
                transition: 'background 0.12s, color 0.12s',
                width: '100%',
              }}
              onMouseEnter={e => {
                if (!active) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  e.currentTarget.style.color = 'white';
                }
              }}
              onMouseLeave={e => {
                if (!active) {
                  e.currentTarget.style.background = 'none';
                  e.currentTarget.style.color = 'rgba(255,255,255,0.72)';
                }
              }}
            >
              {label}
            </button>
          );
        })}
      </aside>

      {/* ── Content pane ────────────────────────────────────────── */}
      <main style={{
        flex: 1,
        overflow: 'auto',
        background: 'var(--bg)',
        padding: '20px 24px',
      }}>
        <Current />
      </main>
    </div>
  );
}
