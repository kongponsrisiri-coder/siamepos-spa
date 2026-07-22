import React, { useState, useEffect } from 'react';
import { getStaff } from '../api.js';

import TradingSection         from './admin/TradingSection.jsx';
import ReportsSection         from './admin/ReportsSection.jsx';
import ZReportSection         from './admin/ZReportSection.jsx';
import TreatmentMenuSection   from './admin/TreatmentMenuSection.jsx';
import TherapistSection       from './admin/TherapistSection.jsx';
import StaffSection           from './admin/StaffSection.jsx';
import RoomSection            from './admin/RoomSection.jsx';
import BookingSettingsSection from './admin/BookingSettingsSection.jsx';
import EmbedCodesSection      from './admin/EmbedCodesSection.jsx';
import ColorCodesSection      from './admin/ColorCodesSection.jsx';
import SettingsSection        from './admin/SettingsSection.jsx';
import RotaSection            from './admin/RotaSection.jsx';
import BillsSection           from './admin/BillsSection.jsx';
import VouchersSection        from './admin/VouchersSection.jsx';
import PaymentsSection        from './admin/PaymentsSection.jsx';
import ClientsSection         from './admin/ClientsSection.jsx';
import CampaignsSection       from './admin/CampaignsSection.jsx';
import OnlineBookingSection   from './admin/OnlineBookingSection.jsx';
import TreatwellSection        from './admin/TreatwellSection.jsx';
import ChatsSection            from './admin/ChatsSection.jsx';
import CertificatesSection     from './admin/CertificatesSection.jsx'; // SPA-CERTS-001

// ── Sandy: AdminScreen — left sidebar, SiamEPOS Spa brand CI ──────
// Slate Navy var(--navy) sidebar · Thai Gold var(--gold) active state
// Grouped navigation mirrors SiamEPOS admin pattern

// SEPOS-SPA-BUGHUNT — collapsible sidebar groups (drop-lists) so the long nav
// doesn't overflow the screen. Each group expands/collapses; the active section's
// group auto-opens and the open set persists across sessions. Mirrors the
// restaurant admin sidebar.
const GROUPS = [
  { title: 'Revenue', items: [
    { k: 'trading',    label: 'Trading' },
    { k: 'reports',    label: 'Reports' },
    { k: 'zreport',    label: 'Z Report' },
  ] },
  { title: 'Clients', items: [
    { k: 'bills',      label: 'Bills' },
    { k: 'clients',    label: 'Clients' },
    { k: 'chats',      label: 'AI Chats' },
    { k: 'campaigns',  label: 'Campaigns' },
    { k: 'treatwell',  label: 'Treatwell' },
    { k: 'vouchers',   label: 'Vouchers' },
    { k: 'payments',   label: 'Payments' },
  ] },
  { title: 'Spa', items: [
    { k: 'menu',       label: 'Treatments' },
    { k: 'therapists', label: 'Therapists' },
    { k: 'staff',      label: 'Staff' },
    { k: 'rota',       label: 'Rota' },
    { k: 'rooms',      label: 'Rooms' },
    { k: 'certs',      label: 'Certificates' },
  ] },
  { title: 'Settings', items: [
    { k: 'booking',    label: 'Booking' },
    { k: 'online',     label: 'Online Booking' },
    { k: 'embed',      label: 'Embed Codes' },
    { k: 'colors',     label: 'Colour Codes' },
    { k: 'settings',   label: 'Settings' },
  ] },
];

const OPEN_GROUPS_KEY = 'spa_admin_open_groups';
const groupContaining = (k) => GROUPS.find((g) => g.items.some((i) => i.k === k))?.title || null;

// One section button — shared by the desktop collapsible groups and the mobile
// flat tab strip (styles.css restyles .admin-sidebar button for each layout).
function NavItem({ item, active, onClick }) {
  return (
    <button
      data-active={active}
      onClick={onClick}
      style={{
        background: active ? 'var(--gold)' : 'transparent',
        border: 'none',
        borderLeft: active ? '4px solid #E8C96A' : '4px solid transparent',
        color: active ? 'var(--navy)' : 'white',
        padding: '10px 20px',
        paddingLeft: 16,
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 13.5,
        fontWeight: active ? 700 : 500,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        transition: 'background 0.12s, color 0.12s',
        width: '100%',
        lineHeight: 1.3,
        minHeight: 42,
        WebkitTapHighlightColor: 'transparent',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {item.label}
    </button>
  );
}

const SECTIONS = {
  trading:    TradingSection,
  reports:    ReportsSection,
  zreport:    ZReportSection,
  bills:      BillsSection,
  clients:    ClientsSection,
  campaigns:  CampaignsSection,
  treatwell:  TreatwellSection,
  chats:      ChatsSection,
  vouchers:   VouchersSection,
  payments:   PaymentsSection,
  menu:       TreatmentMenuSection,
  therapists: TherapistSection,
  staff:      StaffSection,
  rota:       RotaSection,
  rooms:      RoomSection,
  certs:      CertificatesSection,
  booking:    BookingSettingsSection,
  online:     OnlineBookingSection,
  embed:      EmbedCodesSection,
  colors:     ColorCodesSection,
  settings:   SettingsSection,
};

export default function AdminScreen() {
  const [tab, setTab] = useState('trading');
  const [openGroups, setOpenGroups] = useState(() => {
    try { const raw = localStorage.getItem(OPEN_GROUPS_KEY); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return new Set(a); } } catch {}
    const init = groupContaining('trading');
    return new Set(init ? [init] : []);
  });
  // Persist which groups are open across sessions.
  useEffect(() => { try { localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...openGroups])); } catch {} }, [openGroups]);
  // Keep the active section's group open so the highlighted item is always visible.
  useEffect(() => {
    const g = groupContaining(tab);
    if (g) setOpenGroups((prev) => (prev.has(g) ? prev : new Set([...prev, g])));
  }, [tab]);
  const toggleGroup = (title) => setOpenGroups((prev) => {
    const n = new Set(prev);
    if (n.has(title)) n.delete(title); else n.add(title);
    return n;
  });
  // SEPOS-SPA-BUGHUNT — collapsing is a desktop space-saver. On mobile the sidebar
  // is a horizontal scrolling tab strip (see styles.css @768px), so we render a FLAT
  // list of all sections there — collapsible groups would hide most sections.
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
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
    <div className="admin-layout" style={{
      display: 'flex',
      // 100dvh (dynamic viewport) so iOS Safari's hideable address bar
      // doesn't push content below the visible area. The .admin-layout
      // media query in styles.css adjusts further on mobile to leave
      // room for the fixed bottom-nav.
      height: 'calc(100dvh - 52px)',
      margin: '-16px -16px 0',
      width: 'calc(100% + 32px)',
      overflow: 'hidden',
    }}>

      {/* ── Sidebar (left on desktop, horizontal bar on mobile) ── */}
      <aside className="admin-sidebar" style={{
        width: 200,
        minWidth: 200,
        background: 'var(--navy)',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 20,
        paddingBottom: 20,
        flexShrink: 0,
        overflowY: 'auto',
        boxShadow: '2px 0 12px rgba(14,28,55,0.22)',
      }}>
        <div className="admin-panel-label" style={{
          color: 'var(--gold)',
          fontWeight: 700,
          fontSize: 10,
          padding: '0 20px 14px',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          Admin Panel
        </div>

        {isMobile ? (
          // Mobile: flat horizontal tab strip of every section (no collapse).
          GROUPS.flatMap((g) => g.items).map((item) => (
            <NavItem key={item.k} item={item} active={tab === item.k} onClick={() => setTab(item.k)} />
          ))
        ) : (
          // Desktop: collapsible drop-list groups to save vertical space.
          GROUPS.map((group) => {
            const isOpen = openGroups.has(group.title);
            return (
              <div key={group.title}>
                <button
                  onClick={() => toggleGroup(group.title)}
                  className="admin-group-label"
                  style={{
                    background: 'none', border: 'none',
                    color: 'rgba(201,168,76,0.7)',
                    fontWeight: 700,
                    fontSize: 10,
                    padding: '14px 20px 5px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    borderTop: '1px solid rgba(255,255,255,0.10)',
                    marginTop: 4,
                    width: '100%',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  <span>{group.title}</span>
                  <span style={{ fontSize: 9, opacity: 0.8 }}>{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && group.items.map((item) => (
                  <NavItem key={item.k} item={item} active={tab === item.k} onClick={() => setTab(item.k)} />
                ))}
              </div>
            );
          })
        )}
      </aside>

      {/* ── Content pane ────────────────────────────────────────── */}
      <main className="admin-content" style={{
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
