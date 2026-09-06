// SPA-RBAC-001 — role permissions on the till (mirror of services/permissions.js).
// The matrix is loaded from GET /api/permissions after login and cached in
// localStorage so the nav renders instantly on the next load. Admin is
// always full.
import { api, getStaff } from './api.js';

export const SECTION_GROUPS = [
  { title: 'Revenue',  items: [['trading', 'Trading'], ['reports', 'Reports'], ['zreport', 'Z Report']] },
  { title: 'Clients',  items: [['bills', 'Bills'], ['clients', 'Clients (customer database)'], ['chats', 'AI Chats'], ['campaigns', 'Campaigns'], ['treatwell', 'Treatwell'], ['vouchers', 'Vouchers'], ['payments', 'Payments']] },
  { title: 'Spa',      items: [['menu', 'Treatments'], ['therapists', 'Therapists'], ['staff', 'Staff'], ['rota', 'Rota (roster)'], ['rooms', 'Rooms'], ['certs', 'Certificates']] },
  { title: 'Settings', items: [['booking', 'Booking'], ['online', 'Online Booking'], ['embed', 'Embed Codes'], ['colors', 'Colour Codes'], ['settings', 'Settings']] },
  { title: 'Till',     items: [['discounts', 'Discount controls (checkout)']] },
];
export const ROLES = [['manager', 'Manager'], ['reception', 'Reception'], ['therapist', 'Therapist']];
export const LEVELS = [['none', 'Hidden'], ['view', 'View only'], ['edit', 'View + edit']];
const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.items.map(([k]) => k));

export function defaults() {
  const p = {};
  for (const [r] of ROLES) {
    p[r] = {};
    for (const s of ALL_SECTIONS) p[r][s] = r === 'manager' ? 'edit' : 'none';
    p[r].discounts = 'edit';
  }
  return p;
}

const KEY = 'spa_role_permissions';
let perms = null;
function read() {
  if (perms) return perms;
  try { const raw = localStorage.getItem(KEY); if (raw) perms = JSON.parse(raw); } catch { /* ignore */ }
  return perms || defaults();
}
export function getPermissions() { return read(); }
export async function refreshPermissions() {
  try {
    const r = await api.get('/permissions');
    if (r && r.permissions) {
      perms = r.permissions;
      try { localStorage.setItem(KEY, JSON.stringify(perms)); } catch { /* ignore */ }
    }
  } catch { /* keep cached */ }
  return read();
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
