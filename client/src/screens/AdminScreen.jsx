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
import CampaignsSection       from './admin/CampaignsSection.jsx';

// ── Sandy: AdminScreen — left sidebar, SiamEPOS Spa brand CI ──────
// Slate Navy #1e3a6e sidebar · Thai Gold #C9A84C active state
// Grouped navigation mirrors SiamEPOS admin pattern

const NAV = [
  // Revenue
  { k: 'trading',    label: '📊 Trading' },
  { k: 'reports',    label: '📈 Reports' },
  { k: 'zreport',    label: '🔐 Z Report' },
  // Clients
  { divider: 'Clients' },
  { k: 'bills',      label: '🧾 Bills' },
  { k: 'clients',    label: '👤 Clients' },
  { k: 'campaigns',  label: '📧 Campaigns' },
  { k: 'vouchers',   label: '🎁 Vouchers' },
  // Spa management
  { divider: 'Spa' },
  { k: 'menu',       label: '💆 Treatments' },
  { k: 'therapists', label: '👥 Therapists' },
  { k: 'rota',       label: '📅 Rota' },
  { k: 'rooms',      label: '🛁 Rooms' },
  // Configuration
  { divider: 'Settings' },
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
  campaigns:  CampaignsSection,
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
      overflow: 'hidden',
    }}>

      {/* ── Left Sidebar ────────────────────────────────────────── */}
      <aside style={{
        width: 200,
        minWidth: 200,
        background: '#1e3a6e',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 20,
        paddingBottom: 20,
        flexShrink: 0,
        overflowY: 'auto',
        boxShadow: '2px 0 12px rgba(14,28,55,0.22)',
      }}>
        {/* Panel label */}
        <div style={{
          color: 'rgba(201,168,76,0.6)',
          fontWeight: 700,
          fontSize: 10,
          padding: '0 20px 14px',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontFamily: 'Inter, sans-serif',
        }}>
          Admin Panel
        </div>

        {NAV.map((item, i) => {
          // ── Group divider / label ──
          if (item.divider) {
            return (
              <div key={`div-${i}`} style={{
                color: 'rgba(201,168,76,0.38)',
                fontWeight: 700,
                fontSize: 9.5,
                padding: '14px 20px 5px',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                fontFamily: 'Inter, sans-serif',
                borderTop: '1px solid rgba(255,255,255,0.06)',
                marginTop: 4,
              }}>
                {item.divider}
              </div>
            );
          }

          // ── Nav item ──
          const active = tab === item.k;
          return (
            <button
              key={item.k}
              onClick={() => setTab(item.k)}
              style={{
                background: active ? 'rgba(201,168,76,0.22)' : 'transparent',
                border: 'none',
                borderLeft: active ? '4px solid #C9A84C' : '4px solid transparent',
                color: active ? '#ffffff' : 'rgba(255,255,255,0.70)',
                padding: '11px 20px',
                paddingLeft: 16,
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 13.5,
                fontWeight: active ? 700 : 400,
                fontFamily: 'Inter, sans-serif',
                transition: 'background 0.12s, color 0.12s',
                width: '100%',
                lineHeight: 1.3,
              }}
              onMouseEnter={e => {
                if (!active) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
                  e.currentTarget.style.color = 'rgba(255,255,255,0.95)';
                }
              }}
              onMouseLeave={e => {
                if (!active) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'rgba(255,255,255,0.70)';
                }
              }}
            >
              {item.label}
            </button>
          );
        })}
      </aside>

      {/* ── Content pane ────────────────────────────────────────── */}
      <main style={{
        flex: 1,
        overflowY: 'auto',
        background: 'var(--bg)',
        padding: '24px 28px',
      }}>
        <Current />
      </main>
    </div>
  );
}
