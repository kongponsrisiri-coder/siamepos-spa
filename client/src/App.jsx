import React from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { getStaff, getToken, clearAuth } from './api.js';

import LoginScreen         from './screens/LoginScreen.jsx';
import AppointmentScreen   from './screens/AppointmentScreen.jsx';
import CheckoutScreen      from './screens/CheckoutScreen.jsx';
import ClientSearchScreen  from './screens/ClientSearchScreen.jsx';
import ClientProfileScreen from './screens/ClientProfileScreen.jsx';
import AdminScreen         from './screens/AdminScreen.jsx';

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
        color: active ? 'var(--primary)' : 'var(--text)',
        textDecoration: 'none',
        fontWeight: active ? 600 : 400,
        padding: '4px 8px',
        borderRadius: 6,
        background: active ? 'rgba(122,79,30,0.08)' : 'transparent',
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
      background: 'white',
      borderBottom: '1px solid var(--border)',
      padding: '10px 20px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 12,
    }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--primary)', fontSize: 18 }}>SiamEPOS Spa</strong>
        <NavLink to="/">Appointments</NavLink>
        <NavLink to="/clients">Clients</NavLink>
        {isAdmin && <NavLink to="/admin">Admin</NavLink>}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span className="muted">{staff?.name} ({staff?.role})</span>
        <button onClick={() => { clearAuth(); navigate('/login'); }}>Log out</button>
      </div>
    </header>
  );
}

function AppShell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopNav />
      <main style={{ flex: 1, padding: 20, maxWidth: 1280, margin: '0 auto', width: '100%' }}>
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
