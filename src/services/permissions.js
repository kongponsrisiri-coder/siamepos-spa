// SPA-RBAC-001 — configurable role permissions (Admin → Roles & Permissions).
//
// The owner sets, per role, what each admin section is: 'none' (hidden),
// 'view' (read-only) or 'edit'. Stored as JSON in settings.role_permissions.
// Admin is always full and cannot be restricted. Defaults reproduce the
// behaviour before this feature existed (manager = everything, reception /
// therapist = no admin menu, everyone may discount at checkout).
const { pool } = require('../db/dbAdapter');

const SECTIONS = [
  'trading', 'reports', 'zreport',
  'bills', 'clients', 'chats', 'campaigns', 'treatwell', 'vouchers', 'payments',
  'menu', 'therapists', 'staff', 'rota', 'rooms', 'certs',
  'booking', 'online', 'embed', 'colors', 'settings',
  'discounts', // till: checkout discount controls (not an admin page)
];
// SPA-HISTORY-LOCK-001 — per-role flag, 'on' | 'off' (not a section level).
const FLAGS = ['history_lock'];
const ROLES = ['manager', 'reception', 'therapist'];
const LEVELS = ['none', 'view', 'edit'];

function defaults() {
  const p = {};
  for (const r of ROLES) {
    p[r] = {};
    for (const s of SECTIONS) p[r][s] = r === 'manager' ? 'edit' : 'none';
    p[r].discounts = 'edit';
    p[r].history_lock = 'off';
  }
  return p;
}

let cache = { at: 0, perms: null };
const TTL_MS = 15_000;

async function load() {
  if (cache.perms && Date.now() - cache.at < TTL_MS) return cache.perms;
  const perms = defaults();
  try {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'role_permissions'`);
    if (rows[0]?.value) {
      const saved = JSON.parse(rows[0].value);
      for (const r of ROLES) {
        for (const s of SECTIONS) {
          const v = saved?.[r]?.[s];
          if (LEVELS.includes(v)) perms[r][s] = v;
        }
        for (const f of FLAGS) { const v = saved?.[r]?.[f]; if (v === 'on' || v === 'off') perms[r][f] = v; }
      }
    }
  } catch (e) { /* unreadable → defaults */ }
  cache = { at: Date.now(), perms };
  return perms;
}
function invalidate() { cache = { at: 0, perms: null }; }

async function levelFor(role, section) {
  if (role === 'admin') return 'edit';
  const perms = await load();
  return perms[role]?.[section] || 'none';
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Which permission section a request falls under, or null when the route is
// part of the till's everyday work (diary, checkout, clients) and stays
// governed by the route's own requireRole.
function sectionForRequest(req) {
  // Works whether called from a router (baseUrl='/api/reports', path='/x')
  // or from the app-level gate (baseUrl='/api', path='/reports/x'): derive
  // both from the full URL so the mapping below is stable.
  const full = String(req.originalUrl || ((req.baseUrl || '') + (req.path || ''))).split('?')[0];
  const m = full.match(/^(\/api\/[^/]+)(\/.*)?$/);
  const base = m ? m[1] : (req.baseUrl || '');
  const path = m ? (m[2] || '/') : (req.path || '');
  const write = WRITE.has(req.method);
  if (base === '/api/reports')          return 'reports';
  if (base === '/api/campaigns')        return 'campaigns';
  if (base === '/api/certificates')     return 'certs';
  if (base === '/api/concierge-admin')  return 'chats';
  if (base === '/api/payment-links')    return 'payments';
  if (base === '/api/treatwell-email')  return path.startsWith('/inbound') ? null : 'treatwell';
  if (base === '/api/treatments')       return write ? 'menu' : null;
  if (base === '/api/rooms')            return write ? 'rooms' : null;
  if (base === '/api/settings')         return write ? 'settings' : null;
  if (base === '/api/therapists') {
    if (path.startsWith('/turn-order')) return null;                 // receptionist's diary tool
    if (/^\/(rota|\d+\/(overrides|availability))/.test(path)) return write ? 'rota' : null;
    return write ? 'therapists' : null;
  }
  if (base === '/api/bills' && /\/discount/.test(path)) return write ? 'discounts' : null;
  return null;
}

// Express middleware: enforce the matrix for non-admin staff on mapped
// sections. Public routes (no req.staff) pass through untouched.
async function gate(req, res, next) {
  try {
    if (!req.staff || req.staff.role === 'admin') return next();
    const section = sectionForRequest(req);
    if (!section) return next();
    const level = await levelFor(req.staff.role, section);
    if (level === 'none') return res.status(403).json({ error: 'forbidden', reason: `no access to ${section}` });
    if (level === 'view' && WRITE.has(req.method)) return res.status(403).json({ error: 'view only — ask the owner for edit access', reason: `view-only on ${section}` });
    req.permissionLevel = level;   // requireRole honours an explicit grant
    return next();
  } catch (e) { return next(); }
}

module.exports = { SECTIONS, ROLES, LEVELS, FLAGS, defaults, load, invalidate, levelFor, sectionForRequest, gate };
