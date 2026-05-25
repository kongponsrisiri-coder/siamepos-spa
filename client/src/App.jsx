import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { getStaff, getToken, clearAuth } from './api.js';
import { socket } from './socket.js';

import LoginScreen         from './screens/LoginScreen.jsx';
import AppointmentScreen   from './screens/AppointmentScreen.jsx';
import CheckoutScreen      from './screens/CheckoutScreen.jsx';
import ClientSearchScreen  from './screens/ClientSearchScreen.jsx';
import ClientProfileScreen from './screens/ClientProfileScreen.jsx';
import AdminScreen         from './screens/AdminScreen.jsx';

// Brand CI: #0D1B3E navy · #C9A84C gold · Cormorant Garamond headings

const LogoBrand = () => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"
      style={{ width: 28, height: 28, flexShrink: 0 }} aria-hidden="true">
      <circle cx="50" cy="50" r="45" fill="none" stroke="#fff" strokeWidth="1.8"/>
      <circle cx="50" cy="50" r="39" fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.28"/>
      <g transform="translate(50,50)">
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#fff"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#fff" opacity="0.82" transform="rotate(72)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#fff" opacity="0.62" transform="rotate(144)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#fff" opacity="0.62" transform="rotate(216)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#fff" opacity="0.82" transform="rotate(288)"/>
        <circle cx="0" cy="0" r="9" fill="#0D1B3E"/>
        <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
      </g>
    </svg>
    <span style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>
      <span style={{ color: 'white' }}>Siam</span><span style={{ color: '#0D1B3E' }}>EPOS</span>
      <span style={{ color: 'rgba(13,27,62,0.65)', fontSize: 11, fontWeight: 600, marginLeft: 5,
        letterSpacing: '0.1em', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase',
        verticalAlign: 'middle' }}>Spa</span>
    </span>
  </span>
);

function Protected({ children }) {
  const location = useLocation();
  if (!getToken()) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

// ── Desktop top nav link ──────────────────────────────────────────
function NavLink({ to, children }) {
  const { pathname } = useLocation();
  const active = pathname === to || (to !== '/' && pathname.startsWith(to));
  return (
    <Link to={to} style={{
      color: active ? '#C9A84C' : 'rgba(13,27,62,0.8)',
      textDecoration: 'none',
      fontWeight: active ? 700 : 500,
      fontSize: 14,
      padding: '6px 14px',
      borderRadius: 6,
      background: active ? '#0D1B3E' : 'transparent',
      border: active ? 'none' : '1px solid rgba(13,27,62,0.25)',
      transition: 'color 0.15s, background 0.15s',
      letterSpacing: '0.01em',
      whiteSpace: 'nowrap',
    }}>{children}</Link>
  );
}

// ── Top navigation bar (desktop) ─────────────────────────────────
function TopNav() {
  const staff = getStaff();
  const navigate = useNavigate();
  const isAdmin = staff && ['admin', 'manager'].includes(staff.role);

  // SPA-OWNER-NOTIFY (browser desktop notification)
  // Once the operator grants permission, every `new_appointment` socket
  // event fires a system notification (works even when the tab is in
  // the background). Permission state is reflected on the bell button.
  const [notifPerm, setNotifPerm] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    function onNewAppointment(a) {
      if (Notification.permission !== 'granted') return;
      try {
        const time = a?.starts_at
          ? new Date(a.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : '';
        const body = `${a?.client_name || 'New booking'} · ${time}`;
        const n = new Notification('🔔 New booking', { body, tag: `appt-${a?.id}`, icon: '/lotus.svg', renotify: false });
        n.onclick = () => { window.focus(); n.close(); };
      } catch {}
    }
    socket.on('new_appointment', onNewAppointment);
    return () => socket.off('new_appointment', onNewAppointment);
  }, []);

  async function enableNotifications() {
    if (typeof Notification === 'undefined') return;
    try {
      const p = await Notification.requestPermission();
      setNotifPerm(p);
      if (p === 'granted') {
        new Notification('🔔 Notifications enabled', { body: 'You\'ll get a pop-up here for every new booking.', icon: '/lotus.svg' });
      }
    } catch {}
  }

  const bellLabel = notifPerm === 'granted' ? '🔔'
                  : notifPerm === 'denied'  ? '🔕'
                  : '🔔 Enable';
  const bellTitle = notifPerm === 'granted' ? 'Browser notifications ON for new bookings'
                  : notifPerm === 'denied'  ? 'Notifications blocked — re-enable in your browser settings (lock icon next to the URL)'
                  : 'Click to enable browser pop-ups for new bookings';

  return (
    <header style={{
      background: '#C9A84C',
      borderBottom: '1px solid rgba(13,27,62,0.12)',
      padding: '0 16px',
      height: 52,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      boxShadow: '0 2px 8px rgba(201,168,76,0.35)',
      flexShrink: 0,
    }}>
      {/* Left: logo + nav */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
        <LogoBrand />
        {/* Desktop nav links — hidden on mobile via CSS */}
        <span className="desktop-only" style={{ width: 1, height: 22, background: 'rgba(13,27,62,0.2)', margin: '0 8px', flexShrink: 0 }} />
        <div className="desktop-only" style={{ display: 'flex', gap: 6 }}>
          <NavLink to="/">Appointments</NavLink>
          <NavLink to="/clients">Clients</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </div>
      </div>

      {/* Right: bell + staff name + logout */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <button
          onClick={enableNotifications}
          disabled={notifPerm === 'denied'}
          title={bellTitle}
          style={{
            background: notifPerm === 'granted' ? 'rgba(13,27,62,0.18)' : 'rgba(13,27,62,0.08)',
            border: `1px solid ${notifPerm === 'granted' ? '#0D1B3E' : 'rgba(13,27,62,0.3)'}`,
            color: notifPerm === 'denied' ? 'rgba(13,27,62,0.35)' : '#0D1B3E',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 13,
            fontWeight: 600,
            cursor: notifPerm === 'denied' ? 'not-allowed' : 'pointer',
            minHeight: 36,
            whiteSpace: 'nowrap',
          }}
        >{bellLabel}</button>
        <span className="desktop-only" style={{ color: '#0D1B3E', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
          {staff?.name}
          <span style={{ color: '#0D1B3E', marginLeft: 6, fontSize: 11, textTransform: 'capitalize', fontWeight: 600 }}>
            {staff?.role}
          </span>
        </span>
        <button
          onClick={() => { clearAuth(); navigate('/login'); }}
          style={{
            background: 'rgba(13,27,62,0.10)',
            border: '1px solid rgba(13,27,62,0.25)',
            color: '#0D1B3E',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            minHeight: 36,
          }}
        >Log out</button>
      </div>
    </header>
  );
}

// ── Bottom navigation bar (mobile only) ──────────────────────────
function BottomNav() {
  const { pathname } = useLocation();
  const staff = getStaff();
  const isAdmin = staff && ['admin', 'manager'].includes(staff.role);

  const items = [
    { to: '/',        icon: CalendarIcon, label: 'Appointments' },
    { to: '/clients', icon: PersonIcon,   label: 'Clients'      },
    ...(isAdmin ? [{ to: '/admin', icon: GearIcon, label: 'Admin' }] : []),
  ];

  return (
    <nav className="bottom-nav">
      {items.map(({ to, icon: Icon, label }) => {
        const active = pathname === to || (to !== '/' && pathname.startsWith(to));
        return (
          <Link key={to} to={to} className={`bottom-nav-item${active ? ' active' : ''}`}>
            <Icon active={active} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

// Inline SVG icons for bottom nav
function CalendarIcon({ active }) {
  const c = active ? '#0D1B3E' : 'rgba(13,27,62,0.45)';
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}
function PersonIcon({ active }) {
  const c = active ? '#0D1B3E' : 'rgba(13,27,62,0.45)';
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  );
}
function GearIcon({ active }) {
  const c = active ? '#0D1B3E' : 'rgba(13,27,62,0.45)';
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

// ── App shell ─────────────────────────────────────────────────────
function AppShell({ children }) {
  return (
    <div style={{ minHeight: '100vh', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <TopNav />
      <main className="app-main" style={{
        flex: 1,
        padding: '16px 16px 0',
        maxWidth: 1280,
        margin: '0 auto',
        width: '100%',
        // No overflow constraint here — `overflow: clip` was blocking
        // every page that doesn't manage its own scroll container.
        // Mobile padding-bottom for the fixed bottom-nav is set via
        // .app-main media query in styles.css.
      }}>
        {children}
      </main>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/"                        element={<Protected><AppShell><AppointmentScreen   /></AppShell></Protected>} />
      <Route path="/checkout/:appointmentId" element={<Protected><AppShell><CheckoutScreen      /></AppShell></Protected>} />
      <Route path="/clients"                 element={<Protected><AppShell><ClientSearchScreen  /></AppShell></Protected>} />
      <Route path="/clients/:id"             element={<Protected><AppShell><ClientProfileScreen /></AppShell></Protected>} />
      <Route path="/admin"                   element={<Protected><AppShell><AdminScreen         /></AppShell></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
