#!/usr/bin/env node
// Rebuilds native modules in the spa root's node_modules for Electron's Node ABI.
// The workspace is split (Electron in electron/, server in ../), so we fetch the
// Electron-targeted prebuilt binary per known native module — the reliable path.
//
// Run via: npm run rebuild:native  (from electron/)
//
// ⚠️ After this, running the server with SYSTEM Node (e.g. `node src/server.js`
// for testing) will fail to load the native module until you rebuild back:
//   cd .. && npm rebuild better-sqlite3-multiple-ciphers
// This is the dev/test ⇄ Electron toggle gotcha — same as the restaurant app.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ELECTRON_VERSION = require('electron/package.json').version;
const ROOT_NODE_MODULES = path.resolve(__dirname, '..', '..', 'node_modules');

// The encrypted SQLite driver (SQLCipher). Plain better-sqlite3 included as a
// fallback in case it's ever used directly.
const NATIVE_MODULES = ['better-sqlite3-multiple-ciphers', 'better-sqlite3'];

let rebuilt = 0;
for (const mod of NATIVE_MODULES) {
  const dir = path.join(ROOT_NODE_MODULES, mod);
  if (!fs.existsSync(dir)) {
    console.log(`[rebuild-native] ${mod}: not installed, skipping`);
    continue;
  }
  console.log(`[rebuild-native] ${mod} → Electron ${ELECTRON_VERSION}`);
  execSync(
    `npx prebuild-install --runtime electron --target ${ELECTRON_VERSION} --force`,
    { cwd: dir, stdio: 'inherit' }
  );
  rebuilt++;
}

if (!rebuilt) {
  console.error('[rebuild-native] no native modules found to rebuild — did you run `npm install` at the spa root?');
  process.exit(1);
}
console.log('[rebuild-native] done');
