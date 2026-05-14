import React, { useState } from 'react';
import { getStaff } from '../api.js';

import TradingSection         from './admin/TradingSection.jsx';
import ReportsSection         from './admin/ReportsSection.jsx';
import ZReportSection         from './admin/ZReportSection.jsx';
import TreatmentMenuSection   from './admin/TreatmentMenuSection.jsx';
import TherapistSection       from './admin/TherapistSection.jsx';
import RoomSection            from './admin/RoomSection.jsx';
import BookingSettingsSection from './admin/BookingSettingsSection.jsx';
import SettingsSection        from './admin/SettingsSection.jsx';

const TABS = [
  { k: 'trading',   t: 'Trading',          C: TradingSection },
  { k: 'reports',   t: 'Reports',          C: ReportsSection },
  { k: 'zreport',   t: 'Z Report',         C: ZReportSection },
  { k: 'menu',      t: 'Treatment Menu',   C: TreatmentMenuSection },
  { k: 'therapists', t: 'Therapists',      C: TherapistSection },
  { k: 'rooms',     t: 'Rooms',            C: RoomSection },
  { k: 'booking',   t: 'Booking',          C: BookingSettingsSection },
  { k: 'settings',  t: 'Settings',         C: SettingsSection },
];

export default function AdminScreen() {
  const [tab, setTab] = useState('trading');
  const staff = getStaff();

  if (!staff || !['admin', 'manager'].includes(staff.role)) {
    return (
      <div className="card">
        <h2>Admin</h2>
        <p className="muted">Admin or manager role required.</p>
      </div>
    );
  }

  const Current = TABS.find((t) => t.k === tab).C;

  return (
    <div className="col">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {TABS.map((t) => (
          <button
            key={t.k}
            className={tab === t.k ? 'primary' : ''}
            onClick={() => setTab(t.k)}
          >{t.t}</button>
        ))}
      </div>
      <Current />
    </div>
  );
}
