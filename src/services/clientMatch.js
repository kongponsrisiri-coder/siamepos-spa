// SPA-CLIENT-FUZZY-001 — forgiving client search + duplicate detection.
//
// Reception mistypes a name ("Somchay", "jon smyth"), finds nothing, and
// creates a second profile. This scores every client in plain JS so cloud
// (PostgreSQL) and the offline till (SQLite) give the SAME results — no
// pg_trgm. A spa has a few thousand clients at most; the list is cached for
// a minute and cleared whenever this server writes a client.
'use strict';

const { pool } = require('../db/dbAdapter');

// ── normalising ─────────────────────────────────────────────────────────────
// Lower-case, strip LATIN accents only (Thai vowel/tone marks are combining
// characters too, and they are part of the spelling), punctuation → space.
function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}@.]+/gu, ' ')
    .replace(/[.]/g, ' ')
    .trim().replace(/\s+/g, ' ');
}
const tokens = (s) => norm(s).split(' ').filter(Boolean);

// UK numbers are stored both ways ("+44 7911…" / "07911…"): compare as 0-led digits.
function phoneDigits(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('44')) d = `0${d.slice(2)}`;
  return d;
}

// Rough sound-alike key for Latin names: first letter + consonant skeleton
// (ph→f, y→i, z→s, ck→k; vowels, h, w, y dropped; doubles collapsed).
// "somchai"/"somchay" → "smc", "jon"/"john" → "jn". Thai names skip it.
function soundKey(t) {
  if (!/^[a-z]+$/.test(t)) return null;
  const s = t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/z/g, 's').replace(/y/g, 'i');
  const rest = s.slice(1).replace(/[aeiouhwy]/g, '');
  return (s[0] + rest).replace(/(.)\1+/g, '$1');
}

// Damerau–Levenshtein (adjacent swaps count as one edit), on code points.
function editDistance(a, b) {
  a = [...a]; b = [...b];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// How well one typed word matches one name word: 0 (no) … 1 (exact).
function wordScore(q, w) {
  if (q === w) return 1;
  if (q.length >= 2 && w.startsWith(q)) return 0.9;           // partial: "som" → somchai
  const qk = soundKey(q);
  if (qk && q.length >= 4 && qk.length >= 2 && qk === soundKey(w)) return 0.85;  // not on 3 letters: "smi" ≠ Sam
  const len = [...q].length;
  const allowed = len <= 2 ? 0 : len <= 4 ? 1 : len <= 8 ? 2 : 3;
  // also compare against the same-length start of a longer word ("wanid" ~ "wanida")
  const dist = Math.min(editDistance(q, w), editDistance(q, [...w].slice(0, len + 1).join('')));
  if (dist <= allowed) return 0.8 - dist * 0.1;
  return 0;
}

// Every typed word must match some name/alias word (any order — "Smith John").
function nameScore(qTokens, nameTokens) {
  if (!qTokens.length || !nameTokens.length) return 0;
  let total = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const w of nameTokens) best = Math.max(best, wordScore(q, w));
    if (!best) return 0;
    total += best;
  }
  return total / qTokens.length;
}

// ── client list cache ───────────────────────────────────────────────────────
let cache = null;
let cacheAt = 0;
const TTL_MS = 60_000;
function invalidate() { cache = null; }
async function allClients() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  const { rows } = await pool.query('SELECT id, name, alias, phone, email FROM clients');
  cache = rows.map((r) => ({
    row: r,
    nameTokens: [...tokens(r.name), ...tokens(r.alias)],
    phone: phoneDigits(r.phone),
    email: String(r.email || '').toLowerCase().trim(),
  }));
  cacheAt = Date.now();
  return cache;
}

/**
 * Fuzzy matches for a search box. Returns [{...client, score}] best-first.
 * Phone: ≥3 typed digits found anywhere in the number. Email: substring.
 */
async function fuzzySearch(q, { limit = 25, excludeIds = new Set() } = {}) {
  const qTokens = tokens(q).filter((t) => !/^\d+$/.test(t) && !t.includes('@'));
  const digits = /[a-z฀-๿]/i.test(q) ? '' : phoneDigits(q);
  const qEmail = q.includes('@') || /^[^\s]+\.[a-z]{2,}$/i.test(q) ? q.toLowerCase().trim() : '';
  const out = [];
  for (const c of await allClients()) {
    if (excludeIds.has(c.row.id)) continue;
    let score = 0;
    if (digits.length >= 3 && c.phone.includes(digits)) score = 0.95;
    if (qEmail && c.email.includes(qEmail)) score = Math.max(score, 0.95);
    if (qTokens.length) score = Math.max(score, nameScore(qTokens, c.nameTokens));
    if (score >= 0.6) out.push({ ...c.row, score: +score.toFixed(3) });
  }
  out.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return out.slice(0, limit);
}

/**
 * Existing clients that look like the one about to be created: same phone,
 * same email, or a near-identical full name. Used by the "This looks like…"
 * warning before a new profile is saved.
 */
async function findLikelyDuplicates({ name, phone, email } = {}, { excludeId = null } = {}) {
  const p = phoneDigits(phone);
  const e = String(email || '').toLowerCase().trim();
  const nTokens = tokens(name);
  const out = [];
  for (const c of await allClients()) {
    if (excludeId && c.row.id === Number(excludeId)) continue;
    const reasons = [];
    if (p.length >= 7 && c.phone && c.phone === p) reasons.push('phone');
    if (e && c.email && c.email === e) reasons.push('email');
    // Name alone only counts when BOTH parts match closely (not just "John").
    if (nTokens.length >= 2 && nameScore(nTokens, c.nameTokens) >= 0.8
        && nameScore(c.nameTokens.slice(0, 2), nTokens) >= 0.8) reasons.push('name');
    if (reasons.length) out.push({ ...c.row, reasons });
  }
  // phone/email first — they're far stronger evidence than a similar name
  out.sort((a, b) => (b.reasons.includes('phone') || b.reasons.includes('email')) - (a.reasons.includes('phone') || a.reasons.includes('email')));
  return out.slice(0, 5);
}

module.exports = { fuzzySearch, findLikelyDuplicates, invalidate, _test: { norm, phoneDigits, soundKey, editDistance, wordScore, nameScore } };
