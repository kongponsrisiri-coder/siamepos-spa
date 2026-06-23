// Tiny fetch wrapper. Reads token from localStorage, kicks back to /login on 401.

const API_BASE = import.meta.env.VITE_API_BASE || '';

export function getToken() {
  return localStorage.getItem('spa_token');
}

export function getStaff() {
  const raw = localStorage.getItem('spa_staff');
  return raw ? JSON.parse(raw) : null;
}

export function setAuth({ token, staff }) {
  localStorage.setItem('spa_token', token);
  localStorage.setItem('spa_staff', JSON.stringify(staff));
}

export function clearAuth() {
  localStorage.removeItem('spa_token');
  localStorage.removeItem('spa_staff');
}

async function request(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearAuth();
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('unauthenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data   = data;  // full body — lets callers read conflict details, alternatives etc.
    throw err;
  }
  return data;
}

export const api = {
  get:  (p)    => request('GET',    p),
  post: (p, b) => request('POST',   p, b),
  put:  (p, b) => request('PUT',    p, b),
  del:  (p)    => request('DELETE', p),
};

// SEPOS-SPA-LICENSE-001 — offline license lock (desktop till). The local server
// exposes these; on the cloud/web they always read "not enforced" (never locks).
export const getLicenseState = () => api.get('/license-state');
export const recheckLicense  = () => api.post('/license-recheck', {});

// Validates a PIN without changing the current session token.
// Returns the staff object ({ id, name, role }) or throws on failure.
export async function loginPin(pin) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Invalid PIN');
  return data.staff;
}
