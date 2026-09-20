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
import PermissionsSection      from './admin/PermissionsSection.jsx'; // SPA-RBAC-001
import MobileAppSection        from './admin/MobileAppSection.jsx'; // SPA-ANDROID-001
import { can, canSeeAdmin, sectionLevel, refreshPermissions } from '../permissions.js'; // SPA-RBAC-001

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
    { k: 'app',        label: 'Mobile App' },           // SPA-ANDROID-001
    { k: 'permissions', label: 'Roles & Permissions' }, // SPA-RBAC-001 — admin only
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
  permissions: PermissionsSection, // SPA-RBAC-001
  app:         MobileAppSection,   // SPA-ANDROID-001
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
  const [, setPermsVer] = useState(0); // SPA-RBAC-001 — re-render after the matrix loads
  const [pickerOpen, setPickerOpen] = useState(false); // SPA-ADMIN-NAV-001 — mobile section menu
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
  // SPA-RBAC-001 — the owner's matrix decides which sections this role sees.
  useEffect(() => { refreshPermissions().then(() => setPermsVer((v) => v + 1)); }, []);
  const visible = (k) => k === 'permissions' ? staff?.role === 'admin' : can(k, 'view');
  const visibleGroups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => visible(i.k)) })).filter((g) => g.items.length > 0);
  const firstVisible = visibleGroups[0]?.items[0]?.k || null;
  useEffect(() => {
    if (firstVisible && !visible(tab)) setTab(firstVisible);
  }, [firstVisible, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!staff || !canSeeAdmin()) {
    return (
      <div style={{ padding: 32 }}>
        <div className="card">
          <h2>Admin</h2>
          <p className="muted">Your role has no admin sections. Ask the owner to grant access under Admin → Roles &amp; Permissions.</p>
        </div>
      </div>
    );
  }
  const currentLabel = (GROUPS.flatMap((g) => g.items).find((i) => i.k === tab) || {}).label || 'Admin';
  const Current = SECTIONS[tab] || TradingSection;
  const readOnly = tab !== 'permissions' && sectionLevel(tab) === 'view';

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
          // SPA-ADMIN-NAV-001 — on a phone the old strip put ~20 sections in a
          // horizontal scroller: everything past "Clients" was off the edge and
          // the active tab was pink-on-pink. Now one button shows where you are
          // and opens the full, grouped list.
          <button
            onClick={() => setPickerOpen(true)}
            style={{
              width: '100%', height: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 10, padding: '0 16px', background: 'rgba(255,255,255,0.12)', border: 'none',
              borderBottom: '2px solid var(--gold)', color: 'white', fontSize: 15, fontWeight: 700,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ color: 'var(--gold)' }}>☰</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#fff' }}>{currentLabel}</span>
            </span>
            <span style={{ color: 'var(--gold)', fontSize: 12 }}>Change ▾</span>
          </button>
        ) : (
          // Desktop: collapsible drop-list groups to save vertical space.
          visibleGroups.map((group) => {
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
        {/* SPA-ADMIN-NAV-001 — full-screen grouped picker (phones only) */}
      {pickerOpen && isMobile && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setPickerOpen(false); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(13,27,62,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-end' }}
        >
          <div style={{
            width: '100%', maxHeight: '82vh', overflowY: 'auto', background: 'var(--navy)',
            borderRadius: '16px 16px 0 0', paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          }}>
            <div style={{ position: 'sticky', top: 0, background: 'var(--navy)', padding: '14px 18px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
              <span style={{ color: 'var(--gold)', fontWeight: 800, fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Admin sections</span>
              <button onClick={() => setPickerOpen(false)} style={{ background: 'transparent', border: 'none', color: 'white', fontSize: 22, minHeight: 0, padding: 0 }}>×</button>
            </div>
            {visibleGroups.map((group) => (
              <div key={group.title} style={{ padding: '10px 0 4px' }}>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '0 18px 6px' }}>{group.title}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '0 14px' }}>
                  {group.items.map((item) => {
                    const on = tab === item.k;
                    return (
                      <button key={item.k}
                        onClick={() => { setTab(item.k); setPickerOpen(false); }}
                        style={{
                          minHeight: 48, borderRadius: 10, textAlign: 'left', padding: '0 12px',
                          // White chip for the current section: --gold on
                          // --navy is unreadable once a spa overrides its brand
                          // colours (Highbury's gold-on-magenta). White always works.
                          background: on ? '#ffffff' : 'rgba(255,255,255,0.10)',
                          color: on ? 'var(--navy)' : 'white',
                          border: on ? '2px solid var(--gold)' : '1px solid rgba(255,255,255,0.22)',
                          boxShadow: on ? '0 2px 10px rgba(0,0,0,0.22)' : 'none',
                          fontWeight: on ? 800 : 600, fontSize: 14,
                        }}>{item.label}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {readOnly && (
          <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>
            👁 View only — your role can see this section but not change it.
          </div>
        )}
        <div className={readOnly ? 'perm-readonly' : undefined}>
          <Current />
        </div>
      </main>
    </div>
  );
}
