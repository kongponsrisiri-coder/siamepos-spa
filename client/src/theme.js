// SPA-BRAND-001 — per-spa branding (logo + 2-colour theme), ported from the
// restaurant EPOS. Brand colours are CSS variables set at app load from the
// spa's settings (applyBrandTheme). Screens can reference these via the CSS
// vars — with the default SiamEPOS colour baked in as fallback — so a spa's
// theme repaints the app. With no override the vars fall back to navy/gold, so
// existing spas look identical (zero change).
//
// Only PRIMARY (brand base) and ACCENT (highlight) are themeable, per spec.
// The hex literals must stay PLAIN hex (they feed <input type=color> + the
// CSS-var fallbacks). Don't wrap them in var().

export const DEFAULT_PRIMARY = '#0D1B3E'; // SiamEPOS navy
export const DEFAULT_ACCENT  = '#C9A84C'; // SiamEPOS gold

// Brand tokens — resolve to the CSS var, default baked in for when it's unset.
export const NAVY = 'var(--brand-primary, #0D1B3E)';
export const GOLD = 'var(--brand-accent, #C9A84C)';

// Preset palettes the spa can pick from { primary, accent }.
export const BRAND_PRESETS = [
  { name: 'SiamEPOS (default)', primary: '#0D1B3E', accent: '#C9A84C' },
  { name: 'Emerald & Gold',     primary: '#0B3D2E', accent: '#D4AF37' },
  { name: 'Charcoal & Copper',  primary: '#1E1E1E', accent: '#B87333' },
  { name: 'Burgundy & Cream',   primary: '#5B1A1A', accent: '#E8D9B5' },
  { name: 'Teal & Coral',       primary: '#0E4D54', accent: '#E4572E' },
  { name: 'Plum & Blush',       primary: '#3B1F3B', accent: '#E7A3B0' },
  { name: 'Sage & Rose',        primary: '#2F4739', accent: '#E0A3A3' }, // spa-friendly calm
];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const isHex = (v) => typeof v === 'string' && HEX.test(v.trim());

// Login/header logo size preset → desktop/mobile pixel heights (matches EPOS).
export const LOGO_PX = {
  small:  { desktop: 150, mobile: 56 },
  medium: { desktop: 200, mobile: 74 },
  large:  { desktop: 250, mobile: 90 },
  xl:     { desktop: 330, mobile: 116 },
};

// Hex helpers — derive hover/pressed shades from the brand colours.
function toRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
const clamp = (c) => Math.max(0, Math.min(255, Math.round(c)));
const toHex = (rgb) => '#' + rgb.map((c) => clamp(c).toString(16).padStart(2, '0')).join('');
// pct > 0 lightens toward white, < 0 darkens toward black.
function shade(hex, pct) {
  const [r, g, b] = toRgb(hex);
  const f = (c) => (pct >= 0 ? c + (255 - c) * (pct / 100) : c * (1 + pct / 100));
  return toHex([f(r), f(g), f(b)]);
}
function rgba(hex, a) { const [r, g, b] = toRgb(hex); return `rgba(${r},${g},${b},${a})`; }

// Apply a spa's brand colours to the WHOLE app. Sets both the EPOS-style
// --brand-* vars (used by the new login) AND the spa's own design-system vars
// (--navy / --gold + their hover/pressed shades, defined in styles.css :root
// and referenced across every screen). So a spa's theme repaints every screen,
// not just the login. Bad / missing values fall back to the defaults, so a
// broken colour can never blank the UI. Call once branding loads (+ after save).
export function applyBrandTheme(branding) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  const p = isHex(branding && branding.brand_primary) ? branding.brand_primary.trim() : DEFAULT_PRIMARY;
  const a = isHex(branding && branding.brand_accent)  ? branding.brand_accent.trim()  : DEFAULT_ACCENT;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--brand-primary', p); set('--brand-accent', a);
  // Spa design-system vars — override so class-styled screens theme too.
  set('--navy', p); set('--navy-2', shade(p, 20)); set('--navy-dark', shade(p, -45)); set('--navy-muted', rgba(p, 0.07));
  set('--gold', a); set('--gold-2', shade(a, 16)); set('--gold-light', shade(a, 90));
}
