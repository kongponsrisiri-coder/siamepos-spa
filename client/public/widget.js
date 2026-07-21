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

  // Expose a tiny fetch helper that sibling SiamEPOS embeds (the gift-voucher
  // widget) rely on. This means a host page only has to load this booking
  // widget (or set window.SPA_API) — it no longer also needs config.js just to
  // populate the voucher widget's treatment list. Guarded so a page that
  // already defines its own spaFetch wins. `path` is the FULL path, e.g.
  // '/api/widget/treatments'.
  if (!window.spaFetch) {
    window.spaFetch = function (path) {
      return fetch((window.SPA_API || API_BASE) + path).then(function (res) {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      });
    };
  }

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
  // Step order (SPA-DATE-FIRST — May 2026 rework):
  //   1 Treatment  2 Date+Therapist  3 Time  4 Details  5 Payment  6 Confirmation
  // Date is picked BEFORE therapist so the therapist list can be
  // filtered to who's actually on shift that day (server enforces
  // the rota — see /api/widget/therapists?date=YYYY-MM-DD). Past
  // dates are blocked client-side (min=today) and server-side
  // (POST /book rejects starts_at < now).
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
      // SPA-PAY-001 deposit payment
      stripeConfig: null,       // { publishable_key, configured, policy }
      stripeInstance: null,     // window.Stripe(publishable_key) handle
      stripeElements: null,     // Stripe Elements instance
      paymentElement: null,     // mounted PaymentElement
      paymentIntentId: null,
      depositAmount: 0,
      totalAmount: 0,
    };
  }

  // ── Stripe loader (lazy) ──────────────────────────────────────────
  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    if (window.__sesStripeLoading) return window.__sesStripeLoading;
    window.__sesStripeLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = function () { resolve(window.Stripe); };
      s.onerror = function () { reject(new Error('Could not load Stripe.js')); };
      document.head.appendChild(s);
    });
    return window.__sesStripeLoading;
  }
  var state = freshState();

  var root, modal;

  // open(opts?)
  //   opts.treatmentId  — pre-select a treatment (advances past step 1)
  //   opts.therapistId  — pre-select a therapist (advances past step 2 IF a
  //                       treatment is also pre-set; otherwise the therapist
  //                       is silently held until the user picks a treatment)
  // The auto-mount button passes a MouseEvent here, so anything that isn't
  // a plain options object is ignored.
  function open(opts) {
    var pre = (opts && typeof opts === 'object' && !opts.target && !opts.nativeEvent) ? opts : {};
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

    if (pre.treatmentId) state.treatmentId = Number(pre.treatmentId);
    if (pre.therapistId) state.therapistId = Number(pre.therapistId);
    if (state.treatmentId)                  state.step = 2;

    render();

    // Kick off the parallel data loads — both are tiny.
    api('/treatments').then(function (r) {
      state.treatments = r.treatments;
      render();
    }).catch(function (err) { state.error = err.message; render(); });
    loadTherapistsForDate(state.date);
  }

  // SPA-DATE-FIRST — reload the therapist list filtered to on-shift
  // therapists for the selected date. Called on open + whenever the
  // customer changes the date in step 2.
  function loadTherapistsForDate(date) {
    var qs = date ? ('?date=' + date) : '';
    api('/therapists' + qs).then(function (r) {
      state.therapists = r.therapists || [];
      // If the previously-picked therapist isn't on shift on the new
      // date, drop them back to "Any available" — they'd hit "0 slots"
      // anyway, this just makes the reason visible.
      if (state.therapistId && !state.therapists.find(function (t) { return t.id === state.therapistId; })) {
        state.therapistId = null;
      }
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

  // Called from step 4 (Details) → decide whether to advance to the
  // deposit step or book straight through (no-deposit policy).
  function submit() {
    if (!state.name.trim() || !state.phone.trim() || !state.gdpr) {
      state.error = 'Please fill in your name and phone number, and accept the GDPR consent to continue.';
      render();
      return;
    }
    state.busy = true; state.error = ''; render();
    api('/stripe-config').then(function (cfg) {
      state.stripeConfig = cfg;
      if (!cfg.configured || (cfg.policy && cfg.policy.deposit_model === 'none')) {
        return submitBooking(null);
      }
      state.busy = false;
      state.step = 5;          // payment step
      render();
      initPayment();
    }).catch(function (err) {
      // Stripe config endpoint failed — book without deposit so widget
      // still works on spas that haven't configured Stripe yet.
      console.warn('[SiamEPOS widget] stripe-config failed, booking without deposit:', err && err.message);
      submitBooking(null);
    });
  }

  function submitBooking(paymentIntentId) {
    state.busy = true; state.error = ''; render();
    var body = {
      treatment_id: state.treatmentId,
      starts_at: state.slot,
      therapist_id: state.therapistId,
      name: state.name, phone: state.phone, email: state.email || undefined,
      notes: state.notes,
      gdpr_consent: state.gdpr,
      marketing_consent: state.marketing,
      payment_intent_id: paymentIntentId || undefined,
    };
    console.log('[SiamEPOS widget] posting /book:', JSON.stringify(body));
    api('/book', { method: 'POST', body: body })
      .then(function (r) {
        state.confirmation = r;
        state.busy = false;
        state.step = 6;           // confirmation
        render();
      })
      .catch(function (err) {
        console.error('[SiamEPOS widget] /book error:', err.message, err);
        state.error = err.message || 'Booking failed — please try again or call us.';
        state.busy = false; render();
      });
  }

  // Initialise Stripe Elements: create a PaymentIntent on the server,
  // load Stripe.js, mount the PaymentElement into the modal.
  function initPayment() {
    state.busy = true; state.error = ''; render();
    Promise.all([
      loadStripeJs(),
      api('/payment-intent', {
        method: 'POST',
        body: { treatment_id: state.treatmentId, starts_at: state.slot, email: state.email || undefined },
      }),
    ]).then(function (out) {
      var Stripe = out[0];
      var pi = out[1];
      state.depositAmount = Number(pi.deposit_amount || 0);
      state.totalAmount   = Number(pi.total_amount   || 0);
      if (pi.skip_payment) {
        // Server confirmed no deposit due → book through.
        return submitBooking(null);
      }
      // SIAMPAY-002 — platform mode: the PaymentIntent lives ON the client's
      // connected account, so Stripe.js must be scoped to it.
      state.stripeInstance  = state.stripeConfig.stripe_account
        ? Stripe(state.stripeConfig.publishable_key, { stripeAccount: state.stripeConfig.stripe_account })
        : Stripe(state.stripeConfig.publishable_key);
      state.stripeElements  = state.stripeInstance.elements({
        clientSecret: pi.client_secret,
        appearance: { theme: 'stripe', variables: { colorPrimary: '#1e3a6e', colorBackground: '#ffffff', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' } },
      });
      state.paymentIntentId = pi.intent_id;
      state.paymentElement  = state.stripeElements.create('payment', { layout: 'tabs' });
      state.busy = false;
      render();    // renderStep5_payment() will mount #ses-card-mount on the next tick
    }).catch(function (err) {
      state.error = (err && err.message) || 'Payment setup failed';
      state.busy = false;
      render();
    });
  }

  function confirmPayment() {
    if (!state.stripeInstance || !state.stripeElements) return;
    state.busy = true; state.error = ''; render();
    state.stripeInstance.confirmPayment({
      elements: state.stripeElements,
      redirect: 'if_required',
    }).then(function (result) {
      if (result.error) {
        state.error = result.error.message || 'Payment failed';
        state.busy = false;
        render();
        return;
      }
      var intentId = (result.paymentIntent && result.paymentIntent.id) || state.paymentIntentId;
      submitBooking(intentId);
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
    // 6 steps: treatment → date+therapist → time → details → payment → confirmation
    for (var i = 1; i <= 6; i++) {
      bar.appendChild(h('div', { className: 'ses-step' + (i <= state.step ? ' active' : '') }, []));
    }
    return bar;
  }

  function render() {
    if (!modal) return;
    modal.innerHTML = '';
    modal.appendChild(header('Book your treatment'));
    modal.appendChild(progress());
    if (state.error) modal.appendChild(h('div', { className: 'ses-error' }, [state.error]));
    modal.appendChild(renderStep());
  }

  function renderStep() {
    if (state.step === 1) return renderStep1();
    if (state.step === 2) return renderStep2();
    if (state.step === 3) return renderStep3();
    if (state.step === 4) return renderStep4();
    if (state.step === 5) return renderStep5_payment();
    if (state.step === 6) return renderStep6_confirmation();
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

  // STEP 2 — Date + Therapist (combined)
  // Date FIRST so the therapist list can be filtered to who's on
  // shift. Past dates are blocked client-side via min=today on the
  // input AND via an explicit guard on the Continue button (Safari
  // iOS sometimes lets the picker scroll past the min). Server
  // enforces the same rule on /book as a final safety net.
  function renderStep2() {
    var wrap = h('div', {}, []);
    var today = todayISO();
    var datePast = state.date && state.date < today;

    // ── Date picker ──
    wrap.appendChild(h('label', { className: 'ses-label' }, ['Date']));
    wrap.appendChild(h('input', {
      className: 'ses-input',
      type: 'date',
      value: state.date,
      min: today,
      onChange: function (e) {
        var v = e.target.value;
        if (v && v < todayISO()) {
          // Some mobile date pickers ignore the min attribute. Snap
          // the value visibly back to today and tell the user why.
          state.date = todayISO();
          state.error = 'Please pick today or a future date — past dates can\'t be booked.';
          render();
          loadTherapistsForDate(state.date);
          return;
        }
        state.date = v;
        state.error = '';
        loadTherapistsForDate(v);
      },
    }, []));
    if (datePast) {
      wrap.appendChild(h('div', {
        style: 'background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:8px 10px;border-radius:6px;font-size:13px;margin-top:6px',
      }, ['⚠ This date is in the past. Pick today or later to continue.']));
    }

    // ── Therapist list (filtered to on-shift on this date) ──
    wrap.appendChild(h('label', { className: 'ses-label', style: 'margin-top:14px' }, ['Therapist']));
    wrap.appendChild(h('p', { className: 'ses-muted', style: 'margin: 0 0 6px' }, [
      'Choose your therapist, or let us pick one for you.',
    ]));

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
      wrap.appendChild(h('div', { className: 'ses-muted', style: 'margin-top:8px' }, [
        'No therapists are on shift this date — please pick another day.',
      ]));
    } else {
      state.therapists.forEach(function (t) {
        var selected = state.therapistId === t.id;
        var avatar = t.photo_url
          ? h('img', { className: 'ses-avatar', src: t.photo_url, alt: '', style: 'object-fit:cover' }, [])
          : h('div', { className: 'ses-avatar' }, [initialsOf(t.name)]);
        wrap.appendChild(h('div', {
          className: 'ses-card' + (selected ? ' selected' : ''),
          onClick: function () { state.therapistId = t.id; render(); },
        }, [
          avatar,
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
        disabled: !state.date || datePast || (state.therapists.length === 0 && state.therapistId === null),
        onClick: function () {
          if (state.date && state.date < todayISO()) {
            state.error = 'Please pick today or a future date.';
            render(); return;
          }
          go(3); loadSlots();
        },
      }, ['Continue']),
    ]));
    return wrap;
  }

  // STEP 3 — Time
  // Date and therapist are picked in step 2 so this step just shows
  // available times for that combination. The header reminds the user
  // what they picked so changing it means going back.
  function renderStep3() {
    var wrap = h('div', {}, []);
    var headerBits = [];
    var dateLabel = (function () {
      try {
        var d = new Date(state.date + 'T12:00:00');
        return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      } catch (_) { return state.date; }
    })();
    headerBits.push(dateLabel);
    if (state.therapistId) {
      var pick = state.therapists.find(function (t) { return t.id === state.therapistId; });
      if (pick) headerBits.push('with ' + pick.name);
    } else {
      headerBits.push('with any available therapist');
    }
    wrap.appendChild(h('p', { className: 'ses-muted', style: 'margin: 0 0 10px' }, [
      headerBits.join(' · '),
    ]));

    wrap.appendChild(h('label', { className: 'ses-label' }, ['Available times']));
    if (!state.slots.length) {
      wrap.appendChild(h('div', { className: 'ses-muted' }, [
        'No availability for this date. Tap Back to try a different day or therapist.',
      ]));
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
        disabled: state.busy,
        onClick: submit,
      }, [state.busy ? 'Booking…' : 'Confirm booking']),
    ]));
    return wrap;
  }

  // STEP 5 — Confirmation
  // STEP 5 — Deposit payment (Stripe Elements)
  function renderStep5_payment() {
    var wrap = h('div', {}, []);
    wrap.appendChild(h('p', { className: 'ses-muted' }, ['Pay the deposit to confirm your booking. You\'ll pay the balance at the spa.']));

    if (state.busy && !state.paymentElement) {
      wrap.appendChild(h('div', { className: 'ses-muted', style: 'padding:20px;text-align:center' }, ['Preparing payment…']));
      return wrap;
    }

    // Summary card
    var dep = Number(state.depositAmount || 0);
    var tot = Number(state.totalAmount || 0);
    var bal = +(tot - dep).toFixed(2);
    wrap.appendChild(h('div', { className: 'ses-card', style: 'display:block;cursor:default;background:#fdf6ec;border-color:#e0c884' }, [
      h('div', { style: 'display:flex;justify-content:space-between;font-size:13px;color:#7a4f1e' }, [
        h('span', {}, ['Treatment']), h('span', {}, ['£' + tot.toFixed(2)]),
      ]),
      h('div', { style: 'display:flex;justify-content:space-between;font-size:14px;font-weight:700;color:#1e3a6e;margin-top:6px' }, [
        h('span', {}, ['Deposit now']), h('span', {}, ['£' + dep.toFixed(2)]),
      ]),
      h('div', { style: 'display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-top:4px' }, [
        h('span', {}, ['Balance at the spa']), h('span', {}, ['£' + bal.toFixed(2)]),
      ]),
    ]));

    // Card mount point — Stripe attaches here after this render returns
    var mountId = 'ses-card-mount';
    wrap.appendChild(h('div', { id: mountId, style: 'margin:14px 0;min-height:50px' }, []));

    // Mount on next tick (after the wrap is in the DOM)
    setTimeout(function () {
      if (state.paymentElement && document.getElementById(mountId)) {
        try { state.paymentElement.unmount(); } catch (e) {}
        state.paymentElement.mount('#' + mountId);
      }
    }, 0);

    wrap.appendChild(h('div', { className: 'ses-actions' }, [
      h('button', { className: 'ses-btn', onClick: function () { go(4); }, disabled: state.busy }, ['Back']),
      h('button', {
        className: 'ses-btn primary',
        disabled: state.busy || !state.paymentElement,
        onClick: confirmPayment,
      }, [state.busy ? 'Processing…' : 'Pay £' + dep.toFixed(2) + ' & confirm']),
    ]));
    return wrap;
  }

  // STEP 6 — Confirmation
  function renderStep6_confirmation() {
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
          ap.deposit_amount > 0 ? h('div', {}, [h('strong', {}, ['Deposit paid: ']), '£' + Number(ap.deposit_amount).toFixed(2)]) : null,
          ap.balance_due > 0   ? h('div', {}, [h('strong', {}, ['Balance on arrival: ']), '£' + Number(ap.balance_due).toFixed(2)]) : null,
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
