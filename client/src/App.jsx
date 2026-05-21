import React from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { getStaff, getToken, clearAuth } from './api.js';

import LoginScreen         from './screens/LoginScreen.jsx';
import AppointmentScreen   from './screens/AppointmentScreen.jsx';
import CheckoutScreen      from './screens/CheckoutScreen.jsx';
import ClientSearchScreen  from './screens/ClientSearchScreen.jsx';
import ClientProfileScreen from './screens/ClientProfileScreen.jsx';
import AdminScreen         from './screens/AdminScreen.jsx';

// ── Sandy: Lotus badge logo mark — Brand CI for SiamEPOS Spa ─────────
// Thai Gold #C9A84C on Slate Navy #1e3a6e (gentler sibling of EPOS #0D1B3E)
const LogoBrand = () => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"
      style={{ width: 30, height: 30, flexShrink: 0 }} aria-hidden="true">
      <circle cx="50" cy="50" r="45" fill="none" stroke="#C9A84C" strokeWidth="1.8"/>
      <circle cx="50" cy="50" r="39" fill="none" stroke="#C9A84C" strokeWidth="0.6" opacity="0.28"/>
      <g transform="translate(50,50)">
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(72)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(144)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.62" transform="rotate(216)"/>
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill="#C9A84C" opacity="0.82" transform="rotate(288)"/>
        <circle cx="0" cy="0" r="9" fill="#1e3a6e"/>
        <circle cx="0" cy="0" r="5" fill="#C9A84C"/>
      </g>
    </svg>
    <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>
      <span style={{ color: 'white' }}>Siam</span><span style={{ color: '#C9A84C' }}>EPOS</span>
      <span style={{ color: 'rgba(201,168,76,0.65)', fontSize: 12, fontWeight: 600, marginLeft: 5, letterSpacing: '0.1em', fontFamily: 'Inter, sans-serif', textTransform: 'uppercase', verticalAlign: 'middle' }}>Spa</span>
    </span>
  </span>
);

function Protected({ children }) {
  const location = useLocation();
  if (!getToken()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

function NavLink({ to, children }) {
  const { pathname } = useLocation();
  const active = pathname === to || (to !== '/' && pathname.startsWith(to));
  return (
    <Link
      to={to}
      style={{
        color: active ? '#C9A84C' : 'rgba(255,255,255,0.75)',
        textDecoration: 'none',
        fontWeight: active ? 600 : 400,
        fontSize: 14,
        padding: '5px 12px',
        borderRadius: 6,
        background: active ? 'rgba(201,168,76,0.12)' : 'transparent',
        transition: 'color 0.15s, background 0.15s',
      }}
    >{children}</Link>
  );
}

function TopNav() {
  const staff = getStaff();
  const navigate = useNavigate();
  const isAdmin = staff && ['admin', 'manager'].includes(staff.role);
  return (
    <header style={{
      background: '#1e3a6e',
      borderBottom: '1px solid rgba(201,168,76,0.18)',
      padding: '0 20px',
      height: 52,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'nowrap',
      gap: 12,
      boxShadow: '0 2px 8px rgba(14,28,55,0.25)',
    }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <LogoBrand />
        <span style={{ width: 1, height: 22, background: 'rgba(201,168,76,0.25)', margin: '0 10px' }} />
        <NavLink to="/">Appointments</NavLink>
        <NavLink to="/clients">Clients</NavLink>
        {isAdmin && <NavLink to="/admin">Admin</NavLink>}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
          {staff?.name}
          <span style={{ color: 'rgba(201,168,76,0.6)', marginLeft: 5, fontSize: 11, textTransform: 'capitalize' }}>{staff?.role}</span>
        </span>
        <button
          onClick={() => { clearAuth(); navigate('/login'); }}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.18)',
            color: 'rgba(255,255,255,0.75)',
            borderRadius: 6,
            padding: '5px 12px',
            fontSize: 13,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
        >Log out</button>
      </div>
    </header>
  );
}

function AppShell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopNav />
      <main style={{ flex: 1, padding: '20px 20px 0', maxWidth: 1280, margin: '0 auto', width: '100%', overflow: 'clip' }}>
        {children}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/"                       element={<Protected><AppShell><AppointmentScreen   /></AppShell></Protected>} />
      <Route path="/checkout/:appointmentId" element={<Protected><AppShell><CheckoutScreen      /></AppShell></Protected>} />
      <Route path="/clients"                 element={<Protected><AppShell><ClientSearchScreen  /></AppShell></Protected>} />
      <Route path="/clients/:id"             element={<Protected><AppShell><ClientProfileScreen /></AppShell></Protected>} />
      <Route path="/admin"                   element={<Protected><AppShell><AdminScreen         /></AppShell></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
