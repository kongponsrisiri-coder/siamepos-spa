// SPA-002 — Embed Codes admin page.
// Shows the spa owner the script tag they paste into their website.
// Two embed patterns are supported by the widget:
//   1. Auto-mount: <script> + <div id="siamespa-booking"></div>
//   2. Manual:    <script> + <button onclick="SiamEPOSSpa.open()">…</button>

import React, { useState } from 'react';

// Best-guess of the public API origin. In production the frontend lives at
// spa.siamepos.co.uk and the backend at spa-api.siamepos.co.uk — we just
// flip the host. If `VITE_API_BASE` is set (e.g. during local dev) we use
// that. The user can also override the value in the textbox below.
function defaultApiOrigin() {
  const fromEnv = import.meta.env.VITE_API_BASE;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const loc = window.location.origin;
  return loc.replace(/^https?:\/\/spa\./, 'https://spa-api.');
}

export default function EmbedCodesSection() {
  const [origin, setOrigin] = useState(defaultApiOrigin());

  const autoMount =
`<script src="${origin}/booking-widget.js" defer></script>
<div id="siamespa-booking"></div>`;

  const manual =
`<script src="${origin}/widget.js" defer></script>
<button onclick="SiamEPOSSpa.open()">Book now</button>`;

  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Public booking widget — embed codes</h3>
        <p className="muted" style={{ margin: 0 }}>
          Copy one of the snippets below and paste it into any page on your
          website. The widget will load on demand and open in a modal — your
          customers don't leave your site.
        </p>

        <div>
          <label>Backend API origin</label>
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="https://spa-api.siamepos.co.uk"
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Edit only if your spa uses a custom API domain.
          </div>
        </div>
      </div>

      <Snippet
        title="Option 1 — drop-in button (recommended)"
        hint="Place the &lt;div&gt; wherever you want the 'Book your treatment' button to appear."
        code={autoMount}
      />

      <Snippet
        title="Option 2 — your own button"
        hint="Use this if you'd rather style the button to match your site."
        code={manual}
      />

      <div className="card col">
        <h3 style={{ margin: 0 }}>Tips</h3>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          <li>The widget pulls treatments, therapists, and availability live from your spa — no extra setup.</li>
          <li>Therapists with a Specialisms field set (in the Therapists tab) will show those words on the picker.</li>
          <li>Bookings made from the widget appear instantly under Trading and in the Appointments calendar.</li>
        </ul>
      </div>
    </div>
  );
}

function Snippet({ title, hint, code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail under http:// or in restricted contexts —
      // fall back to a manual select.
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); }
      finally { document.body.removeChild(ta); }
    }
  }

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <button className="primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      {hint && <div className="muted" style={{ fontSize: 13 }} dangerouslySetInnerHTML={{ __html: hint }} />}
      <pre style={{
        background: '#0f172a', color: '#f8fafc', padding: 12, borderRadius: 6,
        fontSize: 12, whiteSpace: 'pre-wrap', overflow: 'auto', margin: 0,
      }}>{code}</pre>
    </div>
  );
}
