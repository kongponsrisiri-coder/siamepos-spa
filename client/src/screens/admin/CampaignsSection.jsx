// SPA-CAMPAIGNS-001 — admin email campaigns.
// Pick a segment → write subject + body → preview → send via Brevo.
// Unsubscribe link + GDPR footer are added server-side; they're legally
// required and must not be optional.

import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';

const SEGMENTS = [
  { id: 'VIP',       label: '⭐ VIP',       color: '#5b21b6' },
  { id: 'Regular',   label: '🔁 Regular',   color: '#1e40af' },
  { id: 'Lapsed',    label: '😴 Lapsed',    color: '#991b1b' },
  { id: 'Treatwell', label: '🌐 Treatwell', color: '#c2410c' },
  { id: 'All',       label: '👥 All',       color: '#1e3a6e' },
];

const SEGMENT_HINTS = {
  VIP:       'Most loyal clients — 5+ visits or £200+ lifetime spend.',
  Regular:   '2–4 visits — primed to become loyal regulars with the right nudge.',
  Lapsed:    'Haven\'t been in for 60+ days. Win-back is the use case here.',
  Treatwell: 'First reached you via Treatwell. Pitch direct booking — "book direct, save 10%" — and you avoid the commission next time.',
  All:       'Every opted-in client. Use sparingly to avoid burning the list.',
};

const PLACEHOLDER_BODY = `<p>Hi {{name}},</p>

<p>Thanks for visiting us recently — we'd love to see you again.</p>

<p>This month we're running a special on hot stone and Thai herbal compress — book any session before the end of the month and we'll throw in a complimentary tea ritual.</p>

<p>Book direct on our website and you'll always get our best rate.</p>

<p>See you on the table,<br/>The Baan Siam team</p>`;

function PreviewModal({ subject, body, onClose }) {
  const personalised = body.replace(/\{\{\s*name\s*\}\}/gi, 'Sample Guest');
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#faf7f2', borderRadius: 14, width: '100%', maxWidth: 680,
        maxHeight: '90vh', overflow: 'auto', boxShadow: '0 12px 40px rgba(20,38,74,0.35)',
      }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #e8e3d8', background: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Subject</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1e3a6e' }}>{subject || '(empty)'}</div>
          </div>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ background: '#faf7f2', padding: 24 }}>
          <div style={{ background: 'white', borderRadius: 12, maxWidth: 600, margin: '0 auto', boxShadow: '0 2px 8px rgba(20,38,74,0.08)' }}>
            <div style={{ background: '#1e3a6e', color: 'var(--gold)', padding: '28px 30px', fontFamily: 'Georgia, serif', fontSize: 24, fontWeight: 700, borderRadius: '12px 12px 0 0' }}>
              Your Spa Name
            </div>
            <div style={{ padding: 32, lineHeight: 1.65, fontSize: 15, color: '#1c1c1c' }} dangerouslySetInnerHTML={{ __html: personalised }} />
            <div style={{ padding: '18px 30px', background: '#faf7f2', borderTop: '1px solid #e8e3d8', fontSize: 11, color: '#6b6b6b', lineHeight: 1.55, borderRadius: '0 0 12px 12px' }}>
              <div style={{ marginBottom: 6 }}><strong style={{ color: '#1e3a6e' }}>Your Spa Name</strong> · Address (from env)</div>
              <div>You're receiving this because you opted in to occasional offers when booking with us. <span style={{ textDecoration: 'underline' }}>Unsubscribe</span> at any time.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CampaignsSection() {
  const [segment, setSegment] = useState('Lapsed');
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState(PLACEHOLDER_BODY);
  const [count, setCount]     = useState(null);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(false);
  const [history, setHistory] = useState([]);
  const [result, setResult]   = useState(null);

  async function loadCount(seg) {
    try {
      const r = await api.get(`/campaigns/recipient-count?segment=${encodeURIComponent(seg)}`);
      setCount(r?.count ?? 0);
    } catch { setCount(null); }
  }
  async function loadHistory() {
    try {
      const r = await api.get('/campaigns');
      setHistory(r?.campaigns || []);
    } catch {}
  }
  useEffect(() => { loadCount(segment); }, [segment]);
  useEffect(() => { loadHistory(); }, []);

  async function handleSend() {
    if (!subject.trim() || !body.trim()) {
      setResult({ error: 'Subject and body are required.' });
      return;
    }
    if (count === 0) {
      setResult({ error: 'No opted-in clients in this segment.' });
      return;
    }
    if (!window.confirm(`Send this campaign to ${count ?? '?'} ${segment} client${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setSending(true);
    setResult(null);
    try {
      const r = await api.post('/campaigns/send', { subject: subject.trim(), body, segment });
      if (r?.error) {
        setResult({ error: r.error });
      } else {
        setResult({ success: true, ...r });
        setSubject(''); setBody(PLACEHOLDER_BODY);
        loadHistory();
        loadCount(segment);
      }
    } catch (err) {
      setResult({ error: String(err.message || err) });
    } finally { setSending(false); }
  }

  const hint = SEGMENT_HINTS[segment];

  return (
    <div className="col" style={{ maxWidth: 880 }}>
      <div className="section-header">
        <div>
          <h2>Campaigns</h2>
          <div className="sub">Email marketing to opted-in client segments via Brevo</div>
        </div>
      </div>

      {/* ── Audience ────────────────────────────────────────────────── */}
      <div className="card col">
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Audience</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SEGMENTS.map((s) => {
            const active = segment === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSegment(s.id)}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: '2px solid ' + (active ? s.color : 'var(--border)'),
                  background: active ? s.color : 'white',
                  color: active ? 'white' : '#555',
                  fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}
              >{s.label}</button>
            );
          })}
        </div>
        <div style={{ fontSize: 13, color: '#555' }}>
          {count === null
            ? <span className="muted">Counting recipients…</span>
            : <>Sending to <strong style={{ color: '#1e3a6e' }}>{count}</strong> opted-in client{count === 1 ? '' : 's'} in <strong>{segment}</strong></>}
        </div>
        {hint && <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{hint}</div>}
      </div>

      {/* ── Compose ────────────────────────────────────────────────── */}
      <div className="card col">
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. A reminder from Baan Siam Spa"
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Body — HTML allowed · {`{{name}}`} merges the client's first name</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            style={{ fontFamily: "Menlo, Consolas, monospace", fontSize: 13 }}
          />
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => setPreview(true)} disabled={!subject.trim() && !body.trim()}>
            👁 Preview
          </button>
          <button
            className="primary"
            onClick={handleSend}
            disabled={sending || count === 0 || count === null}
            style={{ background: sending ? '#999' : undefined }}
          >
            {sending ? 'Sending…' : `📤 Send to ${count ?? '?'}`}
          </button>
        </div>

        {result && result.error && (
          <div style={{ padding: '12px 16px', borderRadius: 8, background: '#fee2e2', border: '1px solid #fca5a5', color: '#991b1b', fontSize: 13 }}>
            ❌ {result.error}
          </div>
        )}
        {result && result.success && (
          <div style={{ padding: '12px 16px', borderRadius: 8, background: '#dcfce7', border: '1px solid #86efac', color: '#166534', fontSize: 13 }}>
            ✓ Sent to {result.sent} client{result.sent === 1 ? '' : 's'}{result.failed > 0 ? ` · ${result.failed} failed (check the server log)` : ''}.
          </div>
        )}
      </div>

      {/* ── History ────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <div className="card">
          <h3 style={{ margin: '0 0 12px' }}>History</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ padding: '6px 4px' }}>Sent</th>
                  <th style={{ padding: '6px 4px' }}>Segment</th>
                  <th style={{ padding: '6px 4px' }}>Subject</th>
                  <th style={{ padding: '6px 4px', textAlign: 'right' }}>Recipients</th>
                  <th style={{ padding: '6px 4px', textAlign: 'right' }}>Sent</th>
                  <th style={{ padding: '6px 4px', textAlign: 'right' }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 4px', color: '#555' }}>
                      {new Date(h.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                      {' '}
                      {new Date(h.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td style={{ padding: '8px 4px', fontWeight: 600 }}>{h.segment}</td>
                    <td style={{ padding: '8px 4px' }}>{h.subject}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right', color: '#555' }}>{h.recipient_count}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right', color: '#166534', fontWeight: 700 }}>{h.sent_count}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right', color: h.failed_count > 0 ? '#991b1b' : 'var(--muted)' }}>{h.failed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="muted" style={{ fontSize: 11, lineHeight: 1.55 }}>
        <strong>GDPR:</strong> only opted-in clients receive campaigns. The unsubscribe link is added automatically — never remove it. If a client clicks unsubscribe, they're permanently excluded from future campaigns even if you re-toggle their marketing-consent flag.
      </div>

      {preview && <PreviewModal subject={subject} body={body} onClose={() => setPreview(false)} />}
    </div>
  );
}
