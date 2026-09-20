// SPA-RBAC-001 — role permissions on the till (mirror of services/permissions.js).
// The matrix is loaded from GET /api/permissions after login and cached in
// localStorage so the nav renders instantly on the next load. Admin is
// always full.
import { api, getStaff } from './api.js';

export const SECTION_GROUPS = [
  { title: 'Revenue',  items: [['trading', 'Trading'], ['reports', 'Reports'], ['zreport', 'Z Report']] },
  { title: 'Clients',  items: [['bills', 'Bills'], ['clients', 'Clients (customer database)'], ['chats', 'AI Chats'], ['campaigns', 'Campaigns'], ['treatwell', 'Treatwell'], ['vouchers', 'Vouchers'], ['payments', 'Payments']] },
  { title: 'Spa',      items: [['menu', 'Treatments'], ['therapists', 'Therapists'], ['staff', 'Staff'], ['rota', 'Rota (roster)'], ['rooms', 'Rooms'], ['certs', 'Certificates']] },
  { title: 'Settings', items: [['booking', 'Booking'], ['online', 'Online Booking'], ['embed', 'Embed Codes'], ['colors', 'Colour Codes'], ['settings', 'Settings'], ['app', 'Mobile App']] },
  { title: 'Till',     items: [['discounts', 'Discount controls (checkout)']] },
];
export const BUILTIN_ROLES = [['manager', 'Manager'], ['reception', 'Reception'], ['therapist', 'Therapist']];
export const ROLES = BUILTIN_ROLES; // back-compat
// SPA-RBAC-002 — things a role may DO (as opposed to screens it may see).
export const ACTIONS = [
  ['edit_schedule',   'Add / move / cancel bookings'],
  ['refunds',         'Issue refunds (bills and deposits)'],
  ['void_bills',      'Void / delete a bill'],
  ['manage_sessions', 'Sell / edit / void session packages'],
];
const ACTION_DEFAULTS = {
  manager:   { edit_schedule: 'on', refunds: 'on',  void_bills: 'on',  manage_sessions: 'off' },
  reception: { edit_schedule: 'on', refunds: 'off', void_bills: 'off', manage_sessions: 'off' },
  therapist: { edit_schedule: 'on', refunds: 'off', void_bills: 'off', manage_sessions: 'off' },
};
export const LEVELS = [['none', 'Hidden'], ['view', 'View only'], ['edit', 'View + edit']];
const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.items.map(([k]) => k));

export function blankRole() {
  const o = {};
  for (const s of ALL_SECTIONS) o[s] = 'none';
  o.discounts = 'off';
  o.history_lock = 'off';
  for (const [a] of ACTIONS) o[a] = 'off';
  return o;
}

export function defaults(customRoles = []) {
  const p = {};
  for (const [r] of BUILTIN_ROLES) {
    p[r] = {};
    for (const s of ALL_SECTIONS) p[r][s] = r === 'manager' ? 'edit' : 'none';
    p[r].discounts = 'edit';
    p[r].history_lock = 'off'; // SPA-HISTORY-LOCK-001
    for (const [a] of ACTIONS) p[r][a] = ACTION_DEFAULTS[r][a];
  }
  for (const r of (customRoles || [])) p[r.key] = blankRole();
  return p;
}

const KEY = 'spa_role_permissions';
const ROLES_KEY = 'spa_custom_roles';
let perms = null;
function read() {
  if (perms) return perms;
  try { const raw = localStorage.getItem(KEY); if (raw) perms = JSON.parse(raw); } catch { /* ignore */ }
  return perms || defaults();
}
export function getPermissions() { return read(); }
let customRoles = null;
export function getCustomRoles() {
  if (customRoles) return customRoles;
  try { const raw = localStorage.getItem(ROLES_KEY); if (raw) customRoles = JSON.parse(raw); } catch { /* ignore */ }
  return customRoles || [];
}

export async function refreshPermissions() {
  try {
    const r = await api.get('/permissions');
    if (r && r.permissions) {
      perms = r.permissions;
      try { localStorage.setItem(KEY, JSON.stringify(perms)); } catch { /* ignore */ }
    }
    if (r && Array.isArray(r.custom_roles)) {
      customRoles = r.custom_roles;
      try { localStorage.setItem(ROLES_KEY, JSON.stringify(customRoles)); } catch { /* ignore */ }
    }
  } catch { /* keep cached */ }
  return read();
}

// SPA-RBAC-002 — may the signed-in staff member perform this action?
export function canDo(action) {
  const role = getStaff()?.role;
  if (!role) return false;
  if (role === 'admin') return true;
  const v = read()[role]?.[action];
  if (v === 'on' || v === 'off') return v === 'on';
  return (ACTION_DEFAULTS[role] || {})[action] === 'on';   // role predates the setting
}
export function sectionLevel(section, role = getStaff()?.role) {
  if (!role) return 'none';
  if (role === 'admin') return 'edit';
  return read()[role]?.[section] || 'none';
}
export function can(section, level = 'view') {
  const l = sectionLevel(section);
  if (level === 'edit') return l === 'edit';
  return l === 'view' || l === 'edit';
}
export function canSeeAdmin() {
  const role = getStaff()?.role;
  if (!role) return false;
  if (role === 'admin') return true;
  return ALL_SECTIONS.some((s) => s !== 'discounts' && can(s));
}

// SPA-HISTORY-LOCK-001 — is this role blocked from editing past records?
export function historyLocked() {
  const role = getStaff()?.role;
  if (!role || role === 'admin') return false;
  return read()[role]?.history_lock === 'on';
}
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function isPastDay(ymd) { return String(ymd || '').slice(0, 10) < todayISO(); }
