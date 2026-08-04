// SPA-SAVE-TOAST (Highbury request, 2026-08-04) — global save/error feedback.
// "When they save the medical record, nothing tells them it saved." The fix is
// app-wide, not per-screen: api.js calls toast() on every successful save and
// every failed write, so no action is ever silent again (the restaurant's
// table-plan saga taught us silent outcomes gaslight operators).
//
// Deliberately DOM-based with no React wiring so any module can call it in one
// line: `import { toast } from './toast'; toast('✓ Saved');`

let box = null;
let last = { msg: '', at: 0 };

function ensureBox() {
  if (box && document.body.contains(box)) return box;
  box = document.createElement('div');
  box.style.cssText =
    'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:99999;' +
    'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
  document.body.appendChild(box);
  return box;
}

export function toast(msg, type = 'success') {
  try {
    // Collapse identical repeats (per-keystroke saves, retry bursts).
    const now = Date.now();
    if (msg === last.msg && now - last.at < 2000) return;
    last = { msg, at: now };

    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'font-family:-apple-system,system-ui,sans-serif;font-size:14px;font-weight:700;' +
      'padding:10px 18px;border-radius:999px;box-shadow:0 4px 18px rgba(13,27,62,0.25);' +
      'opacity:0;transition:opacity .18s ease;max-width:86vw;text-align:center;' +
      (type === 'error'
        ? 'background:#dc2626;color:#fff;'
        : 'background:#0D1B3E;color:#7ee2a0;border:1px solid rgba(126,226,160,0.35);');
    ensureBox().appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; }, type === 'error' ? 4200 : 2200);
    setTimeout(() => { el.remove(); }, type === 'error' ? 4600 : 2600);
  } catch { /* toast must never break the app */ }
}
