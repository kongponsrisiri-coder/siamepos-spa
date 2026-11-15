// SPA-CLIENT-MERGE-002 — merge preview/confirm modal + "Possible duplicates"
// review list (Admin → Clients). React modals only — no window.prompt/confirm.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { toast } from '../toast.js';

const yesNo = (v) => (v === true || v === 1 || v === '1' ? 'Yes' : 'No');
const REASON = { phone: 'same phone', email: 'same email', name: 'same name', sounds_like: 'similar name' };

function Side({ title, tone, c }) {
  const n = c.counts || {};
  return (
    <div style={{ flex: 1, minWidth: 220, border: `2px solid ${tone}`, borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: tone, textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</div>
      <div style={{ fontWeight: 700, fontSize: 16, margin: '4px 0' }}>{c.name}</div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
        📞 {c.phone || '—'}{c.alt_phone ? ` · ${c.alt_phone}` : ''}<br />
        ✉️ {c.email || '—'}{c.alt_email ? ` · ${c.alt_email}` : ''}<br />
        📅 {n.appointments || 0} booking{n.appointments === 1 ? '' : 's'} · 🎁 {n.vouchers || 0} voucher/package{n.vouchers === 1 ? '' : 's'}<br />
        ⭐ {c.loyalty_visits || 0} loyalty stamp{Number(c.loyalty_visits) === 1 ? '' : 's'} · 🩺 medical form: {n.medical_form ? 'Yes' : 'No'}<br />
        📧 marketing: {yesNo(c.marketing_consent)}{c.unsubscribed_at ? ' (unsubscribed)' : ''}
      </div>
    </div>
  );
}

/**
 * Preview + confirm. keepId = profile that stays, dupId = profile removed.
 * Staff can swap which one stays before confirming.
 */
export function MergeModal({ keepId, dupId, onClose, onMerged }) {
  const [ids, setIds] = useState({ keep: keepId, dup: dupId });
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setP(null); setError(''); setChecked(false);
    api.get(`/clients/${ids.keep}/merge-preview?duplicate_id=${ids.dup}`)
      .then((r) => { if (live) setP(r); })
      .catch((e) => { if (live) setError(e.data?.error || e.message || 'Could not load the preview'); });
    return () => { live = false; };
  }, [ids.keep, ids.dup]);

  async function confirm() {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/clients/${ids.keep}/merge`, { duplicate_id: ids.dup });
      toast(`✓ Merged into ${r.client?.name || 'the main profile'}`);
      onMerged && onMerged(r);
    } catch (e) {
      setError(e.data?.error || e.message || 'Merge failed');
    } finally { setBusy(false); }
  }

  const medical = p && { moved: "The duplicate's medical form moves to the main profile.",
    main_kept: "Both have a medical form — the MAIN profile's form is kept, the duplicate's is deleted.",
    main: "The main profile's medical form stays.", none: 'Neither has a medical form.' }[p.medical];
  const r = p?.result;
  const consentNote = r && (r.marketing_consent
    ? 'Marketing: stays ON (both profiles had agreed).'
    : (p.keep.marketing_consent || p.duplicate.marketing_consent)
      ? 'Marketing: OFF — only one profile had agreed, so a merge never switches it on.'
      : 'Marketing: OFF.');

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: '100%' }}>
        <h3 style={{ marginTop: 0 }}>Merge duplicate profiles · รวมประวัติลูกค้าซ้ำ</h3>
        {!p && !error && <div className="muted">Loading…</div>}
        {error && <div style={{ color: 'var(--danger)', fontSize: 14, marginBottom: 8 }}>{error}</div>}
        {p && (
          <div className="col" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
              <Side title="✓ Main profile — stays" tone="#16a34a" c={p.keep} />
              <Side title="✕ Duplicate — removed" tone="#dc2626" c={p.duplicate} />
            </div>
            <button onClick={() => setIds({ keep: ids.dup, dup: ids.keep })} disabled={busy} style={{ alignSelf: 'flex-start' }}>
              ⇄ Keep the other one instead
            </button>

            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>After the merge, “{r.name}” will have:</div>
              • every booking, bill, voucher, package and loyalty stamp from both ({(p.keep.counts.appointments || 0) + (p.duplicate.counts.appointments || 0)} bookings, {r.loyalty_visits} stamp{Number(r.loyalty_visits) === 1 ? '' : 's'})<br />
              • phone {r.phone || '—'}{r.alt_phone ? ` + ${r.alt_phone}` : ''} · email {r.email || '—'}{r.alt_email ? ` + ${r.alt_email}` : ''}<br />
              • {consentNote}<br />
              • {medical}<br />
              • the duplicate's notes added to the main profile's notes
            </div>

            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 10, fontSize: 13, color: '#991b1b' }}>
              ⚠️ A merge can't be undone from the till. Only merge when you're sure it's the same person.
              <div style={{ marginTop: 2 }}>รวมแล้วย้อนกลับเองไม่ได้ — รวมเฉพาะเมื่อแน่ใจว่าเป็นคนเดียวกัน</div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 14,
              textTransform: 'none', letterSpacing: 'normal', fontWeight: 600, color: 'var(--text)' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              I've checked — this is the same person · ตรวจแล้ว เป็นคนเดียวกัน
            </label>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={!p || !checked || busy}
            style={{ background: checked ? '#16a34a' : undefined }}>
            {busy ? 'Merging…' : 'Merge profiles'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Possible duplicates" review list. canMerge = role may merge. */
export function PossibleDuplicatesPanel({ canMerge, onReview, refreshKey }) {
  const [pairs, setPairs] = useState(null);
  const [total, setTotal] = useState(0);
  const [busyKey, setBusyKey] = useState(null);

  async function load() {
    try {
      const r = await api.get('/clients/possible-duplicates');
      setPairs(r.pairs || []); setTotal(r.total || 0);
    } catch { setPairs([]); }
  }
  useEffect(() => { load(); }, [refreshKey]);

  async function act(pair, path, msg) {
    const key = `${pair.a.id}:${pair.b.id}`;
    setBusyKey(key);
    try {
      await api.post(path, { client_a: pair.a.id, client_b: pair.b.id });
      toast(msg);
      await load();
    } catch (e) { toast(e.data?.error || e.message || 'Failed', 'error'); }
    finally { setBusyKey(null); }
  }

  if (pairs === null) return <div className="muted" style={{ padding: 8 }}>Looking for duplicates…</div>;
  if (!pairs.length) return <div className="muted" style={{ padding: 8 }}>✓ No likely duplicates found.</div>;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {total} pair{total === 1 ? '' : 's'} that may be the same person{total > pairs.length ? ` (showing ${pairs.length})` : ''}.
        {canMerge ? ' Review each one before merging.' : ' Flag the ones you recognise — a manager will merge them.'}
      </div>
      {pairs.map((pr) => {
        const key = `${pr.a.id}:${pr.b.id}`;
        return (
          <div key={key} className="card" style={{ padding: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
            borderLeft: pr.flagged ? '4px solid #f59e0b' : undefined }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 13 }}>
              {[pr.a, pr.b].map((c) => (
                <div key={c.id}><strong>{c.name}</strong> <span className="muted">· {[c.phone, c.email].filter(Boolean).join(' · ') || 'no contact'}</span></div>
              ))}
              <div style={{ fontSize: 11, color: '#92400e', marginTop: 2 }}>
                {pr.flagged ? '🚩 flagged by staff' : ''}{pr.flagged && pr.reasons.length ? ' · ' : ''}{pr.reasons.map((x) => REASON[x] || x).join(', ')}
              </div>
            </div>
            {canMerge ? (
              <>
                <button className="primary" onClick={() => onReview(pr.a.id, pr.b.id)} disabled={busyKey === key}>Review & merge</button>
                <button onClick={() => act(pr, '/clients/duplicate-flags/not-duplicate', 'Marked as different people')} disabled={busyKey === key}>
                  Not the same person
                </button>
              </>
            ) : (
              !pr.flagged && (
                <button onClick={() => act(pr, '/clients/duplicate-flags', '🚩 Flagged for a manager')} disabled={busyKey === key}>🚩 Flag as duplicate</button>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Client profile → "🚩 Duplicate?" — any staff can say "this is the same
 * person as …". The pair lands at the top of Admin → Clients → Possible
 * duplicates for a manager to review (reception can't open Admin by default).
 */
export function FlagDuplicateModal({ client, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); return; }
    const t = setTimeout(() => {
      api.get(`/clients/search?q=${encodeURIComponent(term)}`)
        .then((r) => setResults((r.clients || []).filter((c) => c.id !== client.id).slice(0, 8)))
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, client.id]);

  async function flag(other) {
    setBusy(true);
    try {
      await api.post('/clients/duplicate-flags', { client_a: client.id, client_b: other.id });
      toast(`🚩 Flagged — a manager will review "${client.name}" + "${other.name}"`);
      onClose();
    } catch (e) { toast(e.data?.error || e.message || 'Could not flag', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: '100%' }}>
        <h3 style={{ marginTop: 0 }}>Same person as… · เป็นคนเดียวกับ…</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Find the other profile for <strong>{client.name}</strong>. A manager will check and merge them.
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone or email…" />
        <div className="col" style={{ gap: 4, marginTop: 8, maxHeight: 280, overflowY: 'auto' }}>
          {results.map((c) => (
            <button key={c.id} onClick={() => flag(c)} disabled={busy}
              style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span><strong>{c.name}</strong>{c.approx ? <span className="muted"> · possible match</span> : null}</span>
              <span className="muted" style={{ fontSize: 12 }}>{[c.phone, c.email].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          {q.trim() && !results.length && <div className="muted" style={{ fontSize: 13 }}>No other client found.</div>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
