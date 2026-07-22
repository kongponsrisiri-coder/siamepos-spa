// SPA-CERTS-001 — qualification certificates.
// The spa's credentials in one place so staff can show a customer full-screen
// the moment they ask ("can I see your qualifications?"). Upload once, tap to
// display. Mobile-first — reception often holds a phone/tablet, not a desktop.
// Requested by the spa client (Jinta), built 22 Jul 2026.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, apiBase, authHeader } from '../../api.js';

function fmtDate(t) {
  try { return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

export default function CertificatesSection() {
  const [certs, setCerts] = useState([]);
  const [viewing, setViewing] = useState(null);   // { cert, blobUrl }
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState('');
  const [holder, setHolder] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try { const r = await api.get('/certificates'); setCerts(r.certificates || []); }
    catch { /* transient */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Files are auth-gated, so fetch with the token and show via a blob URL.
  async function view(cert) {
    try {
      const res = await fetch(`${apiBase()}/api/certificates/${cert.id}/file`, { headers: authHeader() });
      if (!res.ok) throw new Error('could not load file');
      const blob = await res.blob();
      setViewing({ cert, blobUrl: URL.createObjectURL(blob), isPdf: (cert.mimetype || '').includes('pdf') });
    } catch (e) { setError(e.message); }
  }
  function closeView() {
    if (viewing?.blobUrl) URL.revokeObjectURL(viewing.blobUrl);
    setViewing(null);
  }

  async function upload() {
    const f = fileRef.current?.files?.[0];
    setError('');
    if (!title.trim()) { setError('Give the certificate a title first'); return; }
    if (!f) { setError('Choose a file (photo or PDF of the certificate)'); return; }
    if (f.size > 5 * 1024 * 1024) { setError('File too large — 5 MB max (a phone photo is fine)'); return; }
    setUploading(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      const res = await api.post('/certificates', {
        title: title.trim(), holder: holder.trim(), filename: f.name, mimetype: f.type, data,
      });
      if (res?.error) throw new Error(res.error);
      setTitle(''); setHolder(''); if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) { setError(e.message || 'upload failed'); }
    finally { setUploading(false); }
  }

  async function remove(cert) {
    if (!window.confirm(`Remove "${cert.title}"? This cannot be undone.`)) return;
    try { await api.del(`/certificates/${cert.id}`); await load(); }
    catch (e) { setError(e.message || 'delete failed'); }
  }

  // ── Full-screen viewer ──
  if (viewing) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: '#111', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#000', color: '#fff' }}>
          <button className="btn" onClick={closeView} style={{ minWidth: 44 }}>‹ Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{viewing.cert.title}</div>
            {viewing.cert.holder ? <div style={{ fontSize: 12.5, opacity: 0.75 }}>{viewing.cert.holder}</div> : null}
          </div>
        </div>
        {viewing.isPdf ? (
          <iframe title={viewing.cert.title} src={viewing.blobUrl} style={{ flex: 1, border: 'none', background: '#fff' }} />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: 12 }}>
            <img src={viewing.blobUrl} alt={viewing.cert.title} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="col">
      <div className="section-header">
        <div>
          <h2>Certificates</h2>
          <div className="sub">Qualifications, insurance and credentials — tap any card to show it full-screen when a customer asks.</div>
        </div>
      </div>

      {/* Upload card */}
      <div className="card col" style={{ gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5 }}>Add a certificate</div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title — e.g. Thai Massage Level 3 Diploma"
          style={{ padding: '11px 13px', borderRadius: 10, border: '1px solid var(--border)', fontSize: 14.5 }} />
        <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Who it belongs to (optional) — e.g. May"
          style={{ padding: '11px 13px', borderRadius: 10, border: '1px solid var(--border)', fontSize: 14.5 }} />
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ fontSize: 14 }} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={uploading} onClick={upload}>{uploading ? 'Uploading…' : '⬆️ Save certificate'}</button>
          <span className="muted" style={{ fontSize: 12.5 }}>JPG / PNG / PDF, up to 5 MB — a clear phone photo works.</span>
        </div>
        {error && <div style={{ color: '#b3261e', fontSize: 13.5 }}>{error}</div>}
      </div>

      {/* List */}
      {certs.length === 0 ? (
        <div className="card muted" style={{ textAlign: 'center', padding: 28 }}>
          No certificates yet — add the spa's qualifications above and they'll always be one tap away.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
          {certs.map((c) => (
            <div key={c.id} className="card col" style={{ gap: 6, cursor: 'pointer' }} onClick={() => view(c)}>
              <div style={{ fontSize: 34, lineHeight: 1 }}>{(c.mimetype || '').includes('pdf') ? '📄' : '🖼️'}</div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{c.title}</div>
              {c.holder ? <div className="muted" style={{ fontSize: 13 }}>{c.holder}</div> : null}
              <div className="muted" style={{ fontSize: 12 }}>Added {fmtDate(c.uploaded_at)}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn" onClick={(e) => { e.stopPropagation(); view(c); }}>👁 Show</button>
                <button className="btn" style={{ color: '#b3261e' }} onClick={(e) => { e.stopPropagation(); remove(c); }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
