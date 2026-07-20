// SPA-WEBCHAT-AI-001 — AI Chats inbox: every concierge conversation (website
// widget + WhatsApp) in one place, with per-thread human takeover. Mobile-first:
// list ⇄ thread views swap on small screens; the owner checks this on a phone.
// Built by Krit at Korakot's request 2026-07-21 — flagged to Sam on the board.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../api.js';

function ago(t) {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function displayName(c) {
  if (c.customer_name) return c.customer_name;
  if (c.channel === 'web') return `Website visitor ${String(c.phone).slice(-4)}`;
  return c.phone;
}

export default function ChatsSection() {
  const [convs, setConvs] = useState([]);
  const [open, setOpen] = useState(null);   // phone key of the open thread
  const [thread, setThread] = useState(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef(null);

  const load = useCallback(async () => {
    try { const r = await api.get('/concierge-admin/conversations'); setConvs(r.conversations || []); }
    catch { /* keep last list on transient errors */ }
  }, []);
  const loadThread = useCallback(async (phone) => {
    try { const r = await api.get(`/concierge-admin/conversations/${encodeURIComponent(phone)}`); setThread(r); }
    catch { /* noop */ }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!open) { setThread(null); return; }
    loadThread(open);
    const t = setInterval(() => loadThread(open), 12000);
    return () => clearInterval(t);
  }, [open, loadThread]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [thread?.messages?.length]);

  async function toggleHandoff() {
    if (!thread || busy) return;
    setBusy(true);
    try {
      await api.post(`/concierge-admin/conversations/${encodeURIComponent(thread.phone)}/handoff`, { handoff: !thread.handoff });
      await loadThread(thread.phone); load();
    } finally { setBusy(false); }
  }

  // ── Thread view ──
  if (open && thread) {
    return (
      <div className="col" style={{ height: '100%', minHeight: 0 }}>
        <div className="section-header" style={{ alignItems: 'center', gap: 10 }}>
          <button className="btn" onClick={() => setOpen(null)} style={{ minWidth: 44 }}>‹ Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {displayName(thread)} {thread.channel === 'web' ? '🌐' : '🟢'}
            </h2>
            <div className="sub">{thread.handoff ? 'You are handling this chat — the AI is paused' : 'AI is replying automatically'}</div>
          </div>
          <button className={thread.handoff ? 'btn' : 'btn primary'} disabled={busy} onClick={toggleHandoff}>
            {thread.handoff ? '🤖 Give back to AI' : '✋ Take over'}
          </button>
        </div>
        <div className="card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, background: '#ECE5DD' }}>
          {(thread.messages || []).map((m, i) => (
            <div key={i} style={{
              maxWidth: '84%', padding: '8px 12px', borderRadius: 10, fontSize: 14.5, lineHeight: 1.45,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: '0 1px 1px rgba(0,0,0,.08)',
              alignSelf: m.role === 'user' ? 'flex-start' : 'flex-end',
              background: m.role === 'user' ? '#fff' : '#DCF8C6', color: '#222',
            }}>{m.text}</div>
          ))}
          <div ref={bottomRef} />
        </div>
        {thread.channel !== 'web' ? null : (
          <div className="muted" style={{ fontSize: 12, padding: '6px 2px' }}>
            Website visitors are anonymous until they share contact details in the chat.
          </div>
        )}
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>AI Chats</h2>
          <div className="sub">Every concierge conversation — website 🌐 and WhatsApp 🟢. Tap one to read it or take over from the AI.</div>
        </div>
      </div>
      <div className="card col" style={{ padding: 0, overflow: 'hidden' }}>
        {convs.length === 0 ? (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
            No conversations yet — they appear the moment a customer messages the assistant.
          </div>
        ) : convs.map((c) => (
          <div key={c.phone} onClick={() => setOpen(c.phone)} style={{
            display: 'flex', gap: 12, alignItems: 'center', padding: '13px 16px',
            borderBottom: '1px solid var(--border)', cursor: 'pointer', minHeight: 44,
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: '50%', flex: 'none', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 18,
              background: c.channel === 'web' ? '#eef2f7' : '#e7f6ec',
            }}>{c.channel === 'web' ? '🌐' : '🟢'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                {displayName(c)} {c.handoff ? <span style={{ fontSize: 12, color: '#b3261e' }}>· ✋ yours</span> : null}
              </div>
              <div className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.preview || '…'}
              </div>
            </div>
            <div style={{ textAlign: 'right', flex: 'none' }}>
              <div className="muted" style={{ fontSize: 12 }}>{ago(c.updated_at)}</div>
              <div className="muted" style={{ fontSize: 12 }}>{c.turns} msgs</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
