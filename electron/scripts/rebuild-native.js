#!/usr/bin/env node
// Rebuilds the spa root's native modules for Electron's Node ABI so they load
// inside the packaged desktop app (which spawns the server via ELECTRON_RUN_AS_NODE).
//
// Uses @electron/rebuild (the same engine electron-builder uses), which fetches
// an Electron-targeted PREBUILT binary when one exists and otherwise builds from
// source. The previous prebuild-install-only approach hard-failed on Windows
// when no prebuilt was published for the exact Electron version — @electron/
// rebuild's source fallback fixes that (the CI runners have the build toolchain).
//
// Run via: npm run rebuild:native  (from electron/)
//
// ⚠️ After this, running the server with SYSTEM Node (e.g. `node src/server.js`
// for testing) will fail to load the native module until you rebuild back:
//   cd .. && npm rebuild better-sqlite3-multiple-ciphers

const path = require('path');

const ELECTRON_VERSION = require('electron/package.json').version;
// The spa root holds node_modules with the native module (bundled via
// extraResources). Rebuild it there, not in electron/.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const NATIVE_MODULES = ['better-sqlite3-multiple-ciphers'];

(async () => {
  let rebuild;
  try {
    ({ rebuild } = require('@electron/rebuild'));
  } catch (e) {
    console.error('[rebuild-native] @electron/rebuild not found — run `npm install` in electron/ first.');
    process.exit(1);
  }

  console.log(`[rebuild-native] rebuilding ${NATIVE_MODULES.join(', ')} in ${PROJECT_ROOT} for Electron ${ELECTRON_VERSION}`);
  await rebuild({
    buildPath: PROJECT_ROOT,
    electronVersion: ELECTRON_VERSION,
    onlyModules: NATIVE_MODULES,
    force: true,
  });
  // SPA-WIN-TILL-001 — @electron/rebuild resolves happily when the module
  // isn't even installed (that's how the hollow Windows exe shipped). Verify
  // the compiled engine actually exists and is the right binary format for
  // THIS platform before letting the build continue.
  const fs = require('fs');
  const nodeFile = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3-multiple-ciphers', 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(nodeFile)) {
    console.error('[rebuild-native] FATAL: better_sqlite3.node missing after rebuild:', nodeFile);
    console.error('[rebuild-native] (did the ROOT npm install fail? the module must be installed before rebuilding)');
    process.exit(1);
  }
  const magic = fs.readFileSync(nodeFile).subarray(0, 4);
  const isPE    = magic[0] === 0x4d && magic[1] === 0x5a;                  // 'MZ'
  const isMachO = [0xcf, 0xce, 0xca, 0xfe].includes(magic[0]);            // Mach-O / universal
  if (process.platform === 'win32' && !isPE) {
    console.error('[rebuild-native] FATAL: expected a Windows PE .node, magic =', magic);
    process.exit(1);
  }
  if (process.platform === 'darwin' && !isMachO) {
    console.error('[rebuild-native] FATAL: expected a Mach-O .node, magic =', magic);
    process.exit(1);
  }
  console.log(`[rebuild-native] engine verified (${process.platform}, ${fs.statSync(nodeFile).size} bytes)`);
  console.log('[rebuild-native] done');
})().catch((err) => {
  console.error('[rebuild-native] failed:', err && err.message ? err.message : err);
  process.exit(1);
});
