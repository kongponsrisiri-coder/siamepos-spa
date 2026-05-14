import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { socket } from '../socket.js';
import NewAppointmentModal from '../components/NewAppointmentModal.jsx';

function todayISO() { return new Date().toISOString().slice(0, 10); }

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function AppointmentScreen() {
  const [date, setDate]               = useState(todayISO());
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [showNew, setShowNew]         = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/appointments?date=${date}`);
      setAppointments(r.appointments);
    } finally { setLoading(false); }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const refresh = () => load();
    socket.on('new_appointment', refresh);
    socket.on('appointment_updated', refresh);
    socket.on('appointment_status', refresh);
    return () => {
      socket.off('new_appointment', refresh);
      socket.off('appointment_updated', refresh);
      socket.off('appointment_status', refresh);
    };
  }, [load]);

  async function setStatus(id, status) {
    try {
      await api.put(`/appointments/${id}/status`, { status });
      load();
    } catch (e) { alert(e.message); }
  }

  async function startCheckout(appt) {
    // Make sure a bill exists, then route to checkout.
    try {
      await api.post('/bills', { appointment_id: appt.id });
      navigate(`/checkout/${appt.id}`);
    } catch (e) { alert(e.message); }
  }

  const grouped = {
    upcoming: appointments.filter((a) => a.status === 'booked'),
    in_progress: appointments.filter((a) => a.status === 'in_progress'),
    completed: appointments.filter((a) => a.status === 'completed'),
    other: appointments.filter((a) => ['cancelled', 'no_show'].includes(a.status)),
  };

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ width: 180 }}
          />
          <button onClick={() => setDate(todayISO())}>Today</button>
        </div>
        <button className="primary" onClick={() => setShowNew(true)}>+ New Appointment</button>
      </div>

      {loading && <div className="muted">Loading…</div>}

      {[
        { key: 'upcoming',    title: 'Upcoming' },
        { key: 'in_progress', title: 'In progress' },
        { key: 'completed',   title: 'Completed' },
        { key: 'other',       title: 'Cancelled / No-show' },
      ].map((section) => grouped[section.key].length > 0 && (
        <section key={section.key} className="col">
          <h3 style={{ margin: '12px 0 4px' }}>{section.title} ({grouped[section.key].length})</h3>
          <div className="col" style={{ gap: 8 }}>
            {grouped[section.key].map((a) => (
              <div key={a.id} className="card" style={{ padding: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {fmtTime(a.starts_at)} – {fmtTime(a.ends_at)} · {a.treatment_name || '—'}
                    </div>
                    <div className="muted" style={{ fontSize: 14 }}>
                      {a.client_name || 'Walk-in'} {a.client_phone && `· ${a.client_phone}`}
                      {a.therapist_name && ` · ${a.therapist_name}`}
                      {a.room_name && ` · ${a.room_name}`}
                    </div>
                  </div>
                  <div className="row">
                    <span className={`status-pill status-${a.status}`}>{a.status.replace('_', ' ')}</span>
                    {a.status === 'booked' && (
                      <>
                        <button onClick={() => setStatus(a.id, 'in_progress')}>Start</button>
                        <button onClick={() => setStatus(a.id, 'cancelled')}>Cancel</button>
                      </>
                    )}
                    {a.status === 'in_progress' && (
                      <button className="primary" onClick={() => startCheckout(a)}>Checkout</button>
                    )}
                    {a.status === 'booked' && (
                      <button onClick={() => startCheckout(a)}>Checkout</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {!loading && appointments.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="muted">No appointments for this date.</div>
          <button className="primary" onClick={() => setShowNew(true)} style={{ marginTop: 12 }}>
            + Book the first one
          </button>
        </div>
      )}

      {showNew && (
        <NewAppointmentModal
          defaultDate={date}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); load(); }}
        />
      )}
    </div>
  );
}
