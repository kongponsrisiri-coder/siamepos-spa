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

// Apply a spa's brand colours to the whole app (sets the CSS vars). Bad /
// missing values fall back to the defaults, so a broken colour can never blank
// the UI. Call once branding loads (and after a branding save).
export function applyBrandTheme(branding) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  root.style.setProperty('--brand-primary', isHex(branding && branding.brand_primary) ? branding.brand_primary.trim() : DEFAULT_PRIMARY);
  root.style.setProperty('--brand-accent',  isHex(branding && branding.brand_accent)  ? branding.brand_accent.trim()  : DEFAULT_ACCENT);
}
