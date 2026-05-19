/*!
 * SiamEPOS Spa — Public Booking Widget
 *
 * Embed on any external site:
 *   <script src="https://spa-api.siamepos.co.uk/widget.js" defer></script>
 *   <button onclick="SiamEPOSSpa.open()">Book now</button>
 *
 * OR auto-mount a button — drop this placeholder anywhere on the page:
 *   <div id="siamespa-booking"></div>
 *
 * Optional config (set BEFORE the script loads):
 *   window.SIAMEPOS_SPA_API = 'https://spa-api.siamepos.co.uk';
 */
(function () {
  'use strict';

  var API_BASE = window.SIAMEPOS_SPA_API
    || (function () {
      var s = document.currentScript;
      if (!s) return '';
      try { return new URL(s.src).origin; } catch (e) { return ''; }
    })();

  // -------- styles ----------------------------------------------------------
  var STYLE = `
    .ses-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:2147483600;
      display:flex; align-items:center; justify-content:center; padding:16px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
    .ses-modal { background:#fff; border-radius:14px; width:100%; max-width:520px; max-height:92vh;
      overflow:auto; padding:20px; box-shadow:0 20px 60px rgba(0,0,0,.25); color:#1f2937; }
    .ses-h { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
    .ses-h h3 { margin:0; color:#7a4f1e; font-size:18px; }
    .ses-x { background:none; border:none; font-size:22px; cursor:pointer; color:#6b7280; }
    .ses-steps { display:flex; gap:6px; margin-bottom:14px; }
    .ses-step { flex:1; height:4px; border-radius:2px; background:#e5e7eb; }
    .ses-step.active { background:#7a4f1e; }
    .ses-row { display:flex; gap:10px; }
    .ses-row > * { flex:1; }
    .ses-label { display:block; font-size:12px; color:#6b7280; margin:8px 0 4px; }
    .ses-input, .ses-select { width:100%; padding:9px 10px; border:1px solid #e5e7eb;
      border-radius:6px; font:inherit; box-sizing:border-box; background:#fff; }
    .ses-input:focus, .ses-select:focus { outline:none; border-color:#7a4f1e;
      box-shadow:0 0 0 3px rgba(122,79,30,.12); }
    .ses-card { border:1px solid #e5e7eb; border-radius:8px; padding:10px; margin-bottom:6px;
      cursor:pointer; transition:border-color .1s; display:flex; gap:10px; align-items:center; }
    .ses-card:hover { border-color:#7a4f1e; }
    .ses-card.selected { border-color:#7a4f1e; background:#fdf6ec; }
    .ses-avatar { width:40px; height:40px; border-radius:50%; background:#fdf6ec; color:#7a4f1e;
      display:flex; align-items:center; justify-content:center; font-weight:600; font-size:14px;
      flex-shrink:0; border:1px solid #f0e0c8; }
    .ses-avatar.any { background:#7a4f1e; color:#fff; border-color:#7a4f1e; }
    .ses-slot-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; max-height:200px; overflow:auto; }
    .ses-slot { padding:8px 0; text-align:center; border:1px solid #e5e7eb; border-radius:6px;
      cursor:pointer; background:#fff; }
    .ses-slot:hover { border-color:#7a4f1e; }
    .ses-slot.selected { background:#7a4f1e; color:#fff; border-color:#7a4f1e; }
    .ses-btn { padding:10px 16px; border:1px solid #e5e7eb; background:#fff; border-radius:8px;
      cursor:pointer; font:inherit; }
    .ses-btn.primary { background:#7a4f1e; color:#fff; border-color:#7a4f1e; }
    .ses-btn:disabled { opacity:.5; cursor:not-allowed; }
    .ses-actions { display:flex; justify-content:space-between; margin-top:16px; gap:8px; }
    .ses-error { color:#dc2626; font-size:13px; margin-top:8px; }
    .ses-muted { color:#6b7280; font-size:13px; }
    .ses-consent { display:flex; gap:8px; align-items:flex-start; font-size:13px; margin-top:8px; }
    .ses-consent input { margin-top:3px; }
    .ses-mount-btn { padding:12px 22px; background:#7a4f1e; color:#fff; border:none;
      border-radius:8px; font-size:15px; font-weight:600; cursor:pointer;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
    .ses-mount-btn:hover { background:#a16a2c; }
  `;

  function injectStyle() {
    if (document.getElementById('ses-widget-style')) return;
    var s = document.createElement('style');
    s.id = 'ses-widget-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    return fetch(API_BASE + '/api/widget' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
      });
    });
  }

  function fmtMoney(n) { return '£' + Number(n || 0).toFixed(2); }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function initialsOf(name) {
    if (!name) return '?';
    var parts = String(name).trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  // -------- widget state ----------------------------------------------------
  // Step order matches SPA-002 spec:
  //   1 Treatment  2 Therapist  3 Date+Time  4 Details  5 Confirmation
  function freshState() {
    return {
      step: 1,
      treatments: [],
      treatmentId: null,
      therapists: [],
      therapistId: null,       // null = "Any available"
      date: todayISO(),
      slots: [],
      slot: null,
      name: '', phone: '', email: '', notes: '',
      gdpr: false, marketing: false,
      confirmation: null,
      error: '',
      busy: false,
    };
  }
  var state = freshState();

  var root, modal;

  function open() {
    injectStyle();
    if (root) { root.style.display = 'flex'; return; }
    root = document.createElement('div');
    root.className = 'ses-backdrop';
    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    modal = document.createElement('div');
    modal.className = 'ses-modal';
    root.appendChild(modal);
    document.body.appendChild(root);
    state = freshState();
    render();
    // Kick off the parallel data loads — both are tiny.
    api('/treatments').then(function (r) {
      state.treatments = r.treatments;
      render();
    }).catch(function (err) { state.error = err.message; render(); });
    api('/therapists').then(function (r) {
      state.therapists = r.therapists || [];
      render();
    }).catch(function (err) { state.error = err.message; render(); });
  }

  function close() {
    if (!root) return;
    root.remove();
    root = null; modal = null;
    state = freshState();
  }

  function go(step) { state.step = step; state.error = ''; render(); }

  function loadSlots() {
    if (!state.treatmentId || !state.date) return;
    state.slots = []; state.slot = null;
    var qs = '?treatment_id=' + state.treatmentId + '&date=' + state.date;
    if (state.therapistId) qs += '&therapist_id=' + state.therapistId;
    api('/availability' + qs)
      .then(function (r) { state.slots = r.slots; render(); })
      .catch(function (err) { state.error = err.message; render(); });
  }

  function submit() {
    state.busy = true; state.error = ''; render();
    var body = {
      treatment_id: state.treatmentId,
      starts_at: state.slot,
      therapist_id: state.therapistId,
      name: state.name, phone: state.phone, email: state.email || undefined,
      notes: state.notes,
      gdpr_consent: state.gdpr,
      marketing_consent: state.marketing,
    };
    api('/book', { method: 'POST', body: body })
      .then(function (r) {
        state.confirmation = r;
        state.busy = false;
        state.step = 5;
        render();
      })
      .catch(function (err) {
        state.error = err.message; state.busy = false; render();
      });
  }

  // -------- rendering -------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'className') el.className = attrs[k];
      else if (k === 'onClick') el.addEventListener('click', attrs[k]);
      else if (k === 'onInput') el.addEventListener('input', attrs[k]);
      else if (k === 'onChange') el.addEventListener('change', attrs[k]);
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k in el) el[k] = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function header(title) {
    return h('div', { className: 'ses-h' }, [
      h('h3', {}, [title]),
      h('button', { className: 'ses-x', onClick: close }, ['×']),
    ]);
  }

  function progress() {
    var bar = h('div', { className: 'ses-steps' }, []);
    for (var i = 1; i <= 5; i++) {
      bar.appendChild(h('div', { className: 'ses-step' + (i <= state.step ? ' active' : '') }, []));
    }
    return bar;
  }

  function render() {
    if (!modal) return;
    modal.innerHTML = '';
    modal.appendChild(header('Book your treatment'));
    modal.appendChild(progress());
    modal.appendChild(renderStep());
    if (state.error) modal.appendChild(h('div', { className: 'ses-error' }, [state.error]));
  }

  function renderStep() {
    if (state.step === 1) return renderStep1();
    if (state.step === 2) return renderStep2();
    if (state.step === 3) return renderStep3();
    if (state.step === 4) return renderStep4();
    if (state.step === 5) return renderStep5();
  }

  // STEP 1 — Treatment
  function renderStep1() {
    var wrap = h('div', {}, []);
    wrap.appendChild(h('p', { className: 'ses-muted' }, ['Choose a treatment to begin.']));
    if (!state.treatments.length) {
      wrap.appendChild(h('div', { className: 'ses-muted' }, ['Loading treatments…']));
    } else {
      var byCat = {};
      state.treatments.forEach(function (t) {
        var key = t.category_name || 'Treatments';
        (byCat[key] = byCat[key] || []).push(t);
      });
      Object.keys(byCat).forEach(function (cat) {
        wrap.appendChild(h('div', { className: 'ses-muted', style: 'margin-top:8px;font-weight:600' }, [cat]));
        byCat[cat].forEach(function (t) {
          var selected = state.treatmentId === t.id;
          var card = h('div', {
            className: 'ses-card' + (selected ? ' selected' : ''),
            onClick: function () { state.treatmentId = t.id; render(); },
          }, [
            h('div', { style: 'flex:1;display:flex;justify-content:space-between;align-items:center' }, [
              h('div', {}, [
                h('div', { style: 'font-weight:600' }, [t.name]),
                h('div', { className: 'ses-muted' }, [t.duration_minutes + ' min']),
                t.description ? h('div', { className: 'ses-muted', style: 'margin-top:4px' }, [t.description]) : null,
              ]),
              h('div', { style: 'font-weight:600' }, [fmtMoney(t.price)]),
            ]),
          ]);
          wrap.appendChild(card);
        });
      });
    }
    wrap.appendChild(h('div', { className: 'ses-actions' }, [
      h('span', {}, []),
      h('button', {
        className: 'ses-btn primary',
        disabled: !state.treatmentId,
        onClick: function () { go(2); },
      }, ['Continue']),
    ]));
    return wrap;
  }

  // STEP 2 — Therapist (the SPA-002 marquee feature)
  function renderStep2() {
    var wrap = h('div', {}, []);
    wrap.appendChild(h('p', { className: 'ses-muted' }, ['Choose your therapist, or let us pick one for you.']));

    // "Any available" — always first.
    var anySelected = state.therapistId === null;
    wrap.appendChild(h('div', {
      className: 'ses-card' + (anySelected ? ' selected' : ''),
      onClick: function () { state.therapistId = null; render(); },
    }, [
      h('div', { className: 'ses-avatar any' }, ['✦']),
      h('div', { style: 'flex:1' }, [
        h('div', { style: 'font-weight:600' }, ['Any available therapist']),
        h('div', { className: 'ses-muted' }, ['We\'ll assign the first one free at your chosen time']),
      ]),
    ]));

    if (!state.therapists.length) {
      wrap.appendChild(h('div', { className: 'ses-muted', style: 'margin-top:8px' }, ['Loading therapists…']));
    } else {
      state.therapists.forEach(function (t) {
        var selected = state.therapistId === t.id;
        wrap.appendChild(h('div', {
          className: 'ses-card' + (selected ? ' selected' : ''),
          onClick: function () { state.therapistId = t.id; render(); },
        }, [
          h('div', { className: 'ses-avatar' }, [initialsOf(t.name)]),
          h('div', { style: 'flex:1' }, [
            h('div', { style: 'font-weight:600' }, [t.name]),
            h('div', { className: 'ses-muted' }, [t.specialisms || 'Available']),
          ]),
        ]));
      });
    }

    wrap.appendChild(h('div', { className: 'ses-actions' }, [
      h('button', { className: 'ses-btn', onClick: function () { go(1); } }, ['Back']),
      h('button', {
        className: 'ses-btn primary',
        onClick: function () { go(3); loadSlots(); },
      }, ['Continue']),
    ]));
    return wrap;
  }

  // STEP 3 — Date + Time
  function renderStep3() {
    var wrap = h('div', {}, []);
    if (state.therapistId) {
      var pick = state.therapists.find(function (t) { return t.id === state.therapistId; });
      if (pick) {
        wrap.appendChild(h('div', { className: 'ses-muted', style: 'margin-bottom:6px' }, [
          'Showing times for ' + pick.name + '.',
        ]));
      }
    }
    wrap.appendChild(h('label', { className: 'ses-label' }, ['Date']));
    wrap.appendChild(h('input', {
      className: 'ses-input',
      type: 'date',
      value: state.date,
      min: todayISO(),
      onChange: function (e) { state.date = e.target.value; loadSlots(); },
    }, []));
    wrap.appendChild(h('label', { className: 'ses-label', style: 'margin-top:14px' }, ['Available times']));
    if (!state.slots.length) {
      wrap.appendChild(h('div', { className: 'ses-muted' }, ['No availability for this date.']));
    } else {
      var grid = h('div', { className: 'ses-slot-grid' }, []);
      state.slots.forEach(function (s) {
        var selected = state.slot === s.starts_at;
        grid.appendChild(h('div', {
          className: 'ses-slot' + (selected ? ' selected' : ''),
          onClick: function () { state.slot = s.starts_at; render(); },
        }, [fmtTime(s.starts_at)]));
      });
      wrap.appendChild(grid);
    }
    wrap.appendChild(h('div', { className: 'ses-actions' }, [
      h('button', { className: 'ses-btn', onClick: function () { go(2); } }, ['Back']),
      h('button', {
        className: 'ses-btn primary',
        disabled: !state.slot,
        onClick: function () { go(4); },
      }, ['Continue']),
    ]));
    return wrap;
  }

  // STEP 4 — Details
  function renderStep4() {
    var wrap = h('div', {}, []);
    wrap.appendChild(h('label', { className: 'ses-label' }, ['Full name *']));
    wrap.appendChild(h('input', { className: 'ses-input', value: state.name,
      onInput: function (e) { state.name = e.target.value; } }, []));
    wrap.appendChild(h('div', { className: 'ses-row', style: 'margin-top:8px' }, [
      (function () {
        var c = h('div', {}, []);
        c.appendChild(h('label', { className: 'ses-label' }, ['Phone *']));
        c.appendChild(h('input', { className: 'ses-input', value: state.phone, type: 'tel',
          onInput: function (e) { state.phone = e.target.value; } }, []));
        return c;
      })(),
      (function () {
        var c = h('div', {}, []);
        c.appendChild(h('label', { className: 'ses-label' }, ['Email (for confirmation)']));
        c.appendChild(h('input', { className: 'ses-input', value: state.email, type: 'email',
          onInput: function (e) { state.email = e.target.value; } }, []));
        return c;
      })(),
    ]));
    wrap.appendChild(h('label', { className: 'ses-label' }, ['Notes (optional)']));
    var notesEl = h('textarea', { className: 'ses-input', rows: 2,
      onInput: function (e) { state.notes = e.target.value; } }, []);
    notesEl.value = state.notes;
    wrap.appendChild(notesEl);

    var gdprLabel = h('label', { className: 'ses-consent' }, []);
    var gdprInput = h('input', { type: 'checkbox',
      onChange: function (e) { state.gdpr = e.target.checked; } }, []);
    gdprInput.checked = state.gdpr;
    gdprLabel.appendChild(gdprInput);
    gdprLabel.appendChild(h('span', {}, ['I consent to the storage of my contact details for the purpose of this booking and any related health questionnaire (UK GDPR).']));
    wrap.appendChild(gdprLabel);

    var mktLabel = h('label', { className: 'ses-consent' }, []);
    var mktInput = h('input', { type: 'checkbox',
      onChange: function (e) { state.marketing = e.target.checked; } }, []);
    mktInput.checked = state.marketing;
    mktLabel.appendChild(mktInput);
    mktLabel.appendChild(h('span', {}, ['I would like to receive occasional offers and updates by email.']));
    wrap.appendChild(mktLabel);

    wrap.appendChild(h('div', { className: 'ses-actions' }, [
      h('button', { className: 'ses-btn', onClick: function () { go(3); } }, ['Back']),
      h('button', {
        className: 'ses-btn primary',
        disabled: state.busy || !state.name || !state.phone || !state.gdpr,
        onClick: submit,
      }, [state.busy ? 'Booking…' : 'Confirm booking']),
    ]));
    return wrap;
  }

  // STEP 5 — Confirmation
  function renderStep5() {
    var c = state.confirmation;
    var ap = c && c.appointment;
    var when = ap ? new Date(ap.starts_at).toLocaleString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '';
    return h('div', {}, [
      h('div', { style: 'text-align:center;padding:20px 0;' }, [
        h('div', { style: 'font-size:42px' }, ['✓']),
        h('h3', { style: 'margin:8px 0;color:#16a34a' }, ['Booking confirmed']),
        h('p', { className: 'ses-muted' }, [
          state.email ? ('We have sent a confirmation to ' + state.email + '.') : 'Please save your reference number below.',
        ]),
        ap ? h('div', { className: 'ses-card', style: 'text-align:left;display:block;cursor:default' }, [
          h('div', {}, [h('strong', {}, ['When: ']), when]),
          ap.therapist_name ? h('div', {}, [h('strong', {}, ['Therapist: ']), ap.therapist_name]) : null,
          ap.room_name ? h('div', {}, [h('strong', {}, ['Room: ']), ap.room_name]) : null,
          h('div', {}, [h('strong', {}, ['Reference: ']), '#' + ap.id]),
        ]) : null,
      ]),
      h('div', { className: 'ses-actions' }, [
        h('span', {}, []),
        h('button', { className: 'ses-btn primary', onClick: close }, ['Close']),
      ]),
    ]);
  }

  // -------- auto-mount ------------------------------------------------------
  // If the page has <div id="siamespa-booking"></div> we drop a styled
  // button inside it. The button just calls open().
  function autoMount() {
    var slot = document.getElementById('siamespa-booking');
    if (!slot || slot.getAttribute('data-ses-mounted')) return;
    injectStyle();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ses-mount-btn';
    btn.textContent = 'Book your treatment';
    btn.addEventListener('click', open);
    slot.appendChild(btn);
    slot.setAttribute('data-ses-mounted', '1');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  // -------- public surface -------------------------------------------------
  window.SiamEPOSSpa = {
    open: open,
    close: close,
    apiBase: API_BASE,
  };
})();
