// SPA-CLIENT-FUZZY-001 — shared bits for forgiving client search and the
// new-client duplicate warning (Clients screen + booking form).
import React from 'react';

// SPA-CLIENT-FUZZY-001 — marks where exact results end and spelling-forgiving
// suggestions begin, so staff check before picking one.
export function PossibleMatchesLabel({ style }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', background: '#fef3c7',
      border: '1px solid #fcd34d', borderRadius: 6, padding: '4px 10px', ...style }}>
      🔎 Possible matches — check the name · ชื่อใกล้เคียง โปรดตรวจสอบ
    </div>
  );
}

// SPA-CLIENT-FUZZY-001 — "This looks like [name]. Use existing profile?"
// Shown before a new profile is saved when the phone, email or full name
// matches someone already on file.
export function DuplicateWarning({ matches, onUse, onCreateAnyway, onBack, busy }) {
  const why = { phone: 'same phone', email: 'same email', name: 'similar name' };
  return (
    <div className="col" style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 8, padding: 12 }}>
      <div style={{ fontWeight: 700, color: '#92400e' }}>
        This looks like {matches.length === 1 ? matches[0].name : 'someone already on file'}. Use the existing profile?
      </div>
      <div className="muted" style={{ fontSize: 12 }}>ลูกค้าคนนี้อาจมีประวัติอยู่แล้ว — ใช้ประวัติเดิมไหม?</div>
      {matches.map((m) => (
        <div key={m.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'white', borderRadius: 6, padding: '6px 10px', border: '1px solid #fde68a' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{m.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {[m.phone, m.email].filter(Boolean).join(' · ') || '—'} · {(m.reasons || []).map((r) => why[r] || r).join(', ')}
            </div>
          </div>
          <button className="primary" onClick={() => onUse(m)} disabled={busy}>Use this · ใช้คนนี้</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        {onBack && <button onClick={onBack} disabled={busy}>← Back</button>}
        <button onClick={onCreateAnyway} disabled={busy}>No, it's a different person — create new</button>
      </div>
    </div>
  );
}
