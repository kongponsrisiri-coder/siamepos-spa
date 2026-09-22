#!/usr/bin/env node
/**
 * SPA-APP-ICON-001 — generate the Android launcher icon from the SiamEPOS mark.
 *
 * Korakot: "keep our company logo but shrink it with the 'Spa' on it as well."
 * So the icon is the company mark — the five-petal gold flower in its double
 * ring, exactly as drawn on the login screen — scaled down to make room for
 * SPA set underneath it.
 *
 * The artwork is defined ONCE as SVG below and rasterised to every density, so
 * the icon can never drift between sizes and regenerating after a brand tweak
 * is one command. Chrome does the rasterising (no image libraries to install).
 *
 *   node scripts/make-app-icon.js            # write the icons
 *   node scripts/make-app-icon.js --preview  # write one big PNG to look at first
 *   node scripts/make-app-icon.js --desktop  # the Electron till's icon instead
 *
 * Android adaptive icons: the launcher may crop the outer edge to any shape, so
 * nothing that matters may sit outside the central "safe zone". ic_launcher.xml
 * insets both layers by 16.7%, which lands the artwork exactly in that zone —
 * that is why the art here fills its own canvas rather than being pre-padded.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RES    = path.resolve(__dirname, '../client/android/app/src/main/res');

const NAVY = '#0D1B3E';
const GOLD = '#C9A84C';

// Densities → [legacy square icon px, adaptive layer px]
const DENSITIES = {
  ldpi:    [36, 81],
  mdpi:    [48, 108],
  hdpi:    [72, 162],
  xhdpi:   [96, 216],
  xxhdpi:  [144, 324],
  xxxhdpi: [192, 432],
};

// The company mark, identical to LogoBrand in client/src/App.jsx.
// cx/cy/scale place it; the petal path and ring weights are unchanged.
function mark(cx, cy, scale) {
  const petal = 'M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z';
  // Gentler falloff than the on-screen logo: at 48px the 0.62 petals
  // muddied to olive against navy. Depth cue kept, dirt removed.
  const op = [1, 0.9, 0.8, 0.8, 0.9];
  return `
  <g transform="translate(${cx},${cy}) scale(${scale})">
    <circle cx="0" cy="0" r="45" fill="none" stroke="${GOLD}" stroke-width="1.8"/>
    <circle cx="0" cy="0" r="39" fill="none" stroke="${GOLD}" stroke-width="0.6" opacity="0.28"/>
    ${[0, 72, 144, 216, 288].map((deg, i) =>
      `<path d="${petal}" fill="${GOLD}" opacity="${op[i]}" transform="rotate(${deg})"/>`).join('\n    ')}
    <circle cx="0" cy="0" r="9" fill="${NAVY}"/>
    <circle cx="0" cy="0" r="5" fill="${GOLD}"/>
  </g>`;
}

/**
 * The foreground layer: mark on top, SPA beneath.
 * Drawn on a 100×100 grid and scaled, so proportions hold at every density.
 * The mark sits slightly high of centre because the word below carries visual
 * weight — optically centred rather than measured-centred.
 */
function foregroundSvg(px, withBackground) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
  ${withBackground ? `<rect width="100" height="100" fill="${NAVY}"/>` : ''}
  ${mark(50, 40, 0.68)}
  <text x="50" y="90" text-anchor="middle"
        font-family="'Cormorant Garamond', Georgia, 'Times New Roman', serif"
        font-size="17" font-weight="700" letter-spacing="2.4" fill="${GOLD}">SPA</text>
</svg>`;
}

// The DESKTOP icon (macOS dock / Windows taskbar). Same artwork, but a
// rounded square with its own margin rather than a full-bleed layer: desktop
// icons are not masked by the OS the way Android adaptive icons are, so the
// shape has to be in the file. electron-builder turns this one PNG into .icns
// and .ico at build time.
function desktopSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" rx="22.4" ry="22.4" fill="${NAVY}"/>
  ${mark(50, 42, 0.60)}
  <text x="50" y="86" text-anchor="middle"
        font-family="'Cormorant Garamond', Georgia, 'Times New Roman', serif"
        font-size="15" font-weight="700" letter-spacing="2.2" fill="${GOLD}">SPA</text>
</svg>`;
}

function backgroundSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${NAVY}"/>
</svg>`;
}

// Round legacy icon — same art, clipped to a circle.
function roundSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
  <defs><clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="100" height="100" fill="${NAVY}"/>
    ${mark(50, 40, 0.68)}
    <text x="50" y="90" text-anchor="middle"
          font-family="'Cormorant Garamond', Georgia, 'Times New Roman', serif"
          font-size="17" font-weight="700" letter-spacing="2.4" fill="${GOLD}">SPA</text>
  </g>
</svg>`;
}

function render(svg, px, outFile, transparent) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const html = path.join(tmp, 'i.html');
  fs.writeFileSync(html, `<style>html,body{margin:0;padding:0;background:${transparent ? 'transparent' : NAVY}}</style>${svg}`);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    ...(transparent ? ['--default-background-color=00000000'] : []),
    `--window-size=${px},${px}`,
    `--screenshot=${outFile}`,
    `file://${html}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── run ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CHROME)) {
  console.error('Google Chrome is needed to render the icons and was not found at\n  ' + CHROME);
  process.exit(1);
}

// electron/build/icon.png — the desktop till's icon.
if (process.argv.includes('--desktop')) {
  const dir = path.resolve(__dirname, '../electron/build');
  render(desktopSvg(1024), 1024, path.join(dir, 'icon.png'), true);
  render(desktopSvg(512), 512, path.join(dir, 'icon-512.png'), true);
  console.log('Desktop icon written to electron/build/icon.png (1024) + icon-512.png');
  console.log('Rebuild the desktop app for it to take effect.');
  process.exit(0);
}

// SPA-IOS-001 — the iPad app icon: Apple wants a plain opaque square (it rounds
// the corners itself), so this is the Android preview artwork at 1024 px written
// where @capacitor/assets picks it up for iOS (resources/icon-only.png).
if (process.argv.includes('--ios')) {
  const out = path.resolve(__dirname, '../client/resources/icon-only.png');
  render(foregroundSvg(1024, true), 1024, out, false);
  console.log('iOS icon source written to client/resources/icon-only.png (1024)');
  process.exit(0);
}

if (process.argv.includes('--preview')) {
  const out = path.resolve(__dirname, '../docs/app-icon-preview.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  render(foregroundSvg(512, true), 512, out, false);
  console.log('Preview written to ' + out);
  process.exit(0);
}

for (const [density, [legacy, layer]] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  if (!fs.existsSync(dir)) { console.log(`skip ${density} (no folder)`); continue; }
  render(foregroundSvg(layer, false), layer, path.join(dir, 'ic_launcher_foreground.png'), true);
  render(backgroundSvg(layer), layer, path.join(dir, 'ic_launcher_background.png'), false);
  render(foregroundSvg(legacy, true), legacy, path.join(dir, 'ic_launcher.png'), false);
  render(roundSvg(legacy), legacy, path.join(dir, 'ic_launcher_round.png'), true);
  console.log(`${density.padEnd(8)} launcher ${legacy}px · adaptive layers ${layer}px`);
}
console.log('\nDone. Rebuild the APK to see it: see ANDROID.md');
