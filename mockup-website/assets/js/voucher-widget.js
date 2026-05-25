/**
 * Baan Siam Spa — Gift Voucher Widget
 * Self-contained modal: choose voucher → personalise → mock pay → success
 * Triggered by: window.SiamEPOSSpaVoucher.open()
 */
(function () {
  'use strict';

  /* ── Brand tokens ─────────────────────────────────────────────── */
  var NAVY   = '#1e3a6e';
  var NAVY2  = '#152d56';
  var GOLD   = '#C9A84C';
  var CREAM  = '#faf7f2';
  var MUTED  = '#6b7280';
  var BORDER = '#e5e0d8';

  /* ── Amounts to offer ─────────────────────────────────────────── */
  var AMOUNTS = [25, 50, 75, 100, 150];

  /* ── Category / name helpers (same logic as treatments.html) ──── */
  var CATEGORY_MAP = [
    { test: /thai|nuad|traditional/i,   cat: 'Thai Massage' },
    { test: /aro|aromatherapy/i,        cat: 'Aromatherapy' },
    { test: /foot|feet/i,               cat: 'Foot Massage' },
    { test: /head|neck|shoulder|hns/i,  cat: 'Head, Neck & Shoulder' },
    { test: /pregnan/i,                 cat: 'Pregnancy Massage' },
    { test: /couple|duo/i,              cat: 'Couples Massage' },
    { test: /hot.?stone/i,              cat: 'Hot Stone Massage' },
    { test: /deep.?tissue/i,            cat: 'Deep Tissue Massage' },
    { test: /sport/i,                   cat: 'Sports Massage' },
    { test: /reflex/i,                  cat: 'Reflexology' },
  ];

  var NAME_PREFIXES = [
    { re: /^thai/i,                     label: 'Thai Massage' },
    { re: /^aro|^aromatherapy/i,        label: 'Aromatherapy Massage' },
    { re: /^foot/i,                     label: 'Foot Massage' },
    { re: /^head|^neck|^hns/i,          label: 'Head, Neck & Shoulder' },
    { re: /^pregnan/i,                  label: 'Pregnancy Massage' },
    { re: /^couple/i,                   label: 'Couples Massage' },
    { re: /^hot.?stone/i,               label: 'Hot Stone Massage' },
    { re: /^deep/i,                     label: 'Deep Tissue Massage' },
    { re: /^sport/i,                    label: 'Sports Massage' },
    { re: /^reflex/i,                   label: 'Reflexology' },
  ];

  function resolveCategory(name) {
    for (var i = 0; i < CATEGORY_MAP.length; i++) {
      if (CATEGORY_MAP[i].test.test(name)) return CATEGORY_MAP[i].cat;
    }
    return 'Other';
  }

  function cleanName(raw, dur) {
    var n = String(raw || '').trim();
    for (var i = 0; i < NAME_PREFIXES.length; i++) {
      if (NAME_PREFIXES[i].re.test(n)) return NAME_PREFIXES[i].label + ' — ' + dur + ' min';
    }
    n = n.replace(/^pro\s+week\s*day\s*[\/\\]?\s*/i, '')
         .replace(/\b(mins?|minutes?)\s*$/i, 'min')
         .replace(/\s{2,}/g, ' ').trim();
    if (/\d+\s*min/i.test(n)) return n;
    return n + ' — ' + dur + ' min';
  }

  function gbp(n) { return '£' + Number(n || 0).toFixed(0); }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }
  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = 'BAAN-';
    for (var i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    out += '-';
    for (var j = 0; j < 4; j++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  /* ── CSS injection ────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('bss-voucher-styles')) return;
    var style = document.createElement('style');
    style.id = 'bss-voucher-styles';
    style.textContent = [
      '#bss-voucher-overlay{position:fixed;inset:0;background:rgba(14,25,50,0.72);z-index:9990;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity 0.25s;}',
      '#bss-voucher-overlay.open{opacity:1;}',
      '#bss-voucher-modal{background:#fff;border-radius:16px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(14,25,50,0.3);transform:translateY(20px);transition:transform 0.25s;font-family:Inter,sans-serif;}',
      '#bss-voucher-overlay.open #bss-voucher-modal{transform:translateY(0);}',
      '.bss-v-head{background:' + GOLD + ';border-radius:16px 16px 0 0;padding:20px 24px;display:flex;align-items:center;justify-content:space-between;}',
      '.bss-v-head h2{color:' + NAVY + ';font-family:"Playfair Display",serif;font-size:20px;font-weight:500;margin:0;}',
      '.bss-v-head .bss-v-close{background:none;border:none;color:rgba(13,27,62,0.65);font-size:22px;cursor:pointer;padding:4px 8px;line-height:1;border-radius:6px;transition:color 0.15s;}',
      '.bss-v-head .bss-v-close:hover{color:' + NAVY + ';}',
      '.bss-v-steps{display:flex;gap:0;border-bottom:1px solid ' + BORDER + ';padding:0 24px;}',
      '.bss-v-step{font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:' + MUTED + ';padding:12px 0;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:default;}',
      '.bss-v-step+.bss-v-step{margin-left:20px;}',
      '.bss-v-step.active{color:' + NAVY + ';border-bottom-color:' + GOLD + ';}',
      '.bss-v-body{padding:24px;}',
      /* tabs */
      '.bss-v-tabs{display:flex;gap:8px;margin-bottom:20px;}',
      '.bss-v-tab{flex:1;padding:10px;border:1.5px solid ' + BORDER + ';background:#fff;border-radius:8px;font-size:14px;font-weight:600;color:' + MUTED + ';cursor:pointer;transition:all 0.15s;font-family:Inter,sans-serif;}',
      '.bss-v-tab.active{border-color:' + GOLD + ';background:' + GOLD + ';color:' + NAVY + ';}',
      /* amount grid */
      '.bss-v-amounts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:4px;}',
      '.bss-v-amt{padding:16px 8px;border:1.5px solid ' + BORDER + ';background:#fff;border-radius:10px;font-size:22px;font-weight:700;color:' + NAVY + ';cursor:pointer;font-family:"Playfair Display",serif;transition:all 0.15s;text-align:center;}',
      '.bss-v-amt:hover{border-color:' + GOLD + ';}',
      '.bss-v-amt.selected{border-color:' + GOLD + ';background:' + GOLD + ';color:' + NAVY + ';}',
      /* treatment list */
      '.bss-v-tlist{max-height:260px;overflow-y:auto;border:1px solid ' + BORDER + ';border-radius:10px;margin-bottom:4px;}',
      '.bss-v-titem{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;border-bottom:1px solid ' + BORDER + ';transition:background 0.12s;}',
      '.bss-v-titem:last-child{border-bottom:none;}',
      '.bss-v-titem:hover{background:' + CREAM + ';}',
      '.bss-v-titem.selected{background:#eff6ff;}',
      '.bss-v-titem .bss-v-tname{font-size:14px;font-weight:600;color:' + NAVY + ';}',
      '.bss-v-titem .bss-v-tprice{font-size:14px;font-weight:700;color:' + GOLD + ';}',
      '.bss-v-titem .bss-v-sel{width:18px;height:18px;border-radius:50%;border:2px solid ' + BORDER + ';flex-shrink:0;transition:all 0.12s;}',
      '.bss-v-titem.selected .bss-v-sel{background:' + GOLD + ';border-color:' + GOLD + ';}',
      /* form */
      '.bss-v-field{margin-bottom:14px;}',
      '.bss-v-field label{display:block;font-size:12px;font-weight:600;color:' + NAVY + ';letter-spacing:0.06em;text-transform:uppercase;margin-bottom:5px;}',
      '.bss-v-field input,.bss-v-field textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid ' + BORDER + ';border-radius:8px;font-size:14px;font-family:Inter,sans-serif;color:#1a1a1a;outline:none;transition:border-color 0.15s;}',
      '.bss-v-field input:focus,.bss-v-field textarea:focus{border-color:' + GOLD + ';}',
      '.bss-v-field textarea{resize:vertical;min-height:80px;}',
      '.bss-v-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      /* card field */
      '.bss-v-card-demo{background:' + CREAM + ';border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:' + MUTED + ';}',
      '.bss-v-card-demo strong{color:' + NAVY + ';}',
      /* summary box */
      '.bss-v-summary{background:' + CREAM + ';border-radius:10px;padding:14px 16px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;}',
      '.bss-v-summary .bss-v-slabel{font-size:13px;color:' + MUTED + ';margin-bottom:2px;}',
      '.bss-v-summary .bss-v-sval{font-size:16px;font-weight:700;color:' + NAVY + ';}',
      '.bss-v-summary .bss-v-sprice{font-size:26px;font-weight:700;color:' + GOLD + ';font-family:"Playfair Display",serif;}',
      /* success */
      '.bss-v-success{text-align:center;padding:8px 0 16px;}',
      '.bss-v-check{width:72px;height:72px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:32px;}',
      '.bss-v-voucher-card{background:linear-gradient(135deg,' + NAVY + ' 0%,' + NAVY2 + ' 100%);border-radius:14px;padding:20px 24px;margin:20px 0;color:#fff;}',
      '.bss-v-voucher-card .bss-v-vbrand{font-family:"Playfair Display",serif;font-size:17px;color:' + GOLD + ';margin-bottom:4px;}',
      '.bss-v-voucher-card .bss-v-vcode{font-size:22px;font-weight:700;letter-spacing:0.14em;color:#fff;margin:12px 0 8px;}',
      '.bss-v-voucher-card .bss-v-vmeta{font-size:13px;color:rgba(255,255,255,0.65);}',
      '.bss-v-voucher-card .bss-v-vamt{font-family:"Playfair Display",serif;font-size:28px;color:' + GOLD + ';font-weight:500;}',
      /* button */
      '.bss-v-btn{display:block;width:100%;padding:14px;background:' + GOLD + ';color:' + NAVY + ';border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;transition:background 0.15s;margin-top:8px;}',
      '.bss-v-btn:hover{background:#b8922f;}',
      '.bss-v-btn:disabled{opacity:0.5;cursor:default;}',
      '.bss-v-btn-ghost{background:transparent;color:' + NAVY + ';border:1.5px solid ' + BORDER + ';}',
      '.bss-v-btn-ghost:hover{background:' + CREAM + ';}',
      '.bss-v-btn-gold{background:' + GOLD + ';}',
      '.bss-v-btn-gold:hover{background:#b8922f;}',
      '.bss-v-btns{display:flex;gap:10px;margin-top:16px;}',
      '.bss-v-btns .bss-v-btn{margin-top:0;}',
      '.bss-v-hint{font-size:12px;color:' + MUTED + ';margin-top:6px;}',
      '@media(max-width:480px){.bss-v-amounts{grid-template-columns:repeat(3,1fr);}.bss-v-row2{grid-template-columns:1fr;}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ── State ────────────────────────────────────────────────────── */
  var state = {
    step: 1,         // 1 choose | 2 personalise | 3 pay | 4 success
    tab: 'amount',   // 'amount' | 'treatment'
    amount: null,    // selected £ amount
    treatment: null, // { id, name, price }
    treatments: null,// loaded from API
    recipient: '',
    recipientEmail: '',
    sender: '',
    message: '',
    code: '',
  };

  /* ── Build / destroy overlay ──────────────────────────────────── */
  var overlay = null;

  function close() {
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(function () {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
    }, 260);
    document.body.style.overflow = '';
  }

  function open() {
    injectStyles();
    state.step = 1; state.tab = 'amount';
    state.amount = null; state.treatment = null;
    state.recipient = ''; state.recipientEmail = '';
    state.sender = ''; state.message = '';
    state.code = '';

    overlay = document.createElement('div');
    overlay.id = 'bss-voucher-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.innerHTML = '<div id="bss-voucher-modal"></div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    render();

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.classList.add('open'); });
    });
  }

  /* ── Render dispatcher ────────────────────────────────────────── */
  function render() {
    var modal = document.getElementById('bss-voucher-modal');
    if (!modal) return;
    var stepLabels = ['1. Choose', '2. Personalise', '3. Payment', '4. Done'];
    var stepsHtml = stepLabels.map(function (l, i) {
      return '<span class="bss-v-step' + (state.step === i + 1 ? ' active' : '') + '">' + esc(l) + '</span>';
    }).join('');

    modal.innerHTML =
      '<div class="bss-v-head">'
      + '<h2>🎁 Gift Vouchers</h2>'
      + '<button class="bss-v-close" id="bss-v-close">✕</button>'
      + '</div>'
      + '<div class="bss-v-steps">' + stepsHtml + '</div>'
      + '<div class="bss-v-body" id="bss-v-body"></div>';

    document.getElementById('bss-v-close').addEventListener('click', close);
    renderBody();
  }

  function renderBody() {
    var body = document.getElementById('bss-v-body');
    if (!body) return;
    if (state.step === 1) renderStep1(body);
    else if (state.step === 2) renderStep2(body);
    else if (state.step === 3) renderStep3(body);
    else renderStep4(body);
  }

  /* ── Step 1 — Choose voucher ──────────────────────────────────── */
  function renderStep1(body) {
    var isAmount = state.tab === 'amount';
    var amountsHtml = AMOUNTS.map(function (a) {
      return '<button class="bss-v-amt' + (state.amount === a ? ' selected' : '') + '" data-amt="' + a + '">' + gbp(a) + '</button>';
    }).join('');

    var treatHtml = '';
    if (!isAmount) {
      if (!state.treatments) {
        treatHtml = '<div class="bss-v-tlist" style="padding:20px;text-align:center;color:' + MUTED + ';font-size:14px;">Loading treatments…</div>';
      } else if (!state.treatments.length) {
        treatHtml = '<div class="bss-v-tlist" style="padding:20px;text-align:center;color:' + MUTED + ';font-size:14px;">Could not load treatments — please call us to order a treatment voucher.</div>';
      } else {
        var rows = state.treatments.map(function (t) {
          var sel = state.treatment && state.treatment.id === t.id;
          return '<div class="bss-v-titem' + (sel ? ' selected' : '') + '" data-tid="' + t.id + '">'
            + '<div><div class="bss-v-tname">' + esc(t.displayName) + '</div></div>'
            + '<div style="display:flex;align-items:center;gap:10px;">'
            + '<span class="bss-v-tprice">' + gbp(t.price) + '</span>'
            + '<span class="bss-v-sel"></span>'
            + '</div>'
            + '</div>';
        }).join('');
        treatHtml = '<div class="bss-v-tlist">' + rows + '</div>';
      }
    }

    body.innerHTML =
      '<div class="bss-v-tabs">'
      + '<button class="bss-v-tab' + (isAmount ? ' active' : '') + '" id="bss-tab-amt">Choose an amount</button>'
      + '<button class="bss-v-tab' + (!isAmount ? ' active' : '') + '" id="bss-tab-trt">For a treatment</button>'
      + '</div>'
      + (isAmount
        ? '<div class="bss-v-amounts">' + amountsHtml + '</div>'
           + '<p class="bss-v-hint">Recipient can use towards any treatment at Baan Siam Spa.</p>'
        : treatHtml)
      + '<div class="bss-v-btns">'
      + '<button class="bss-v-btn bss-v-btn-ghost" id="bss-v-cancel-btn">Cancel</button>'
      + '<button class="bss-v-btn" id="bss-v-next1" ' + (canProceedStep1() ? '' : 'disabled') + '>Continue →</button>'
      + '</div>';

    /* Tab toggle */
    document.getElementById('bss-tab-amt').addEventListener('click', function () {
      state.tab = 'amount'; state.treatment = null; render();
    });
    document.getElementById('bss-tab-trt').addEventListener('click', function () {
      state.tab = 'treatment'; state.amount = null; render();
      if (!state.treatments) loadTreatments();
    });

    /* Amount select */
    body.querySelectorAll('.bss-v-amt').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.amount = Number(btn.dataset.amt); renderBody();
      });
    });

    /* Treatment select */
    body.querySelectorAll('.bss-v-titem').forEach(function (row) {
      row.addEventListener('click', function () {
        var tid = Number(row.dataset.tid);
        state.treatment = state.treatments.find(function (t) { return t.id === tid; }) || null;
        renderBody();
      });
    });

    document.getElementById('bss-v-cancel-btn').addEventListener('click', close);
    document.getElementById('bss-v-next1').addEventListener('click', function () {
      if (canProceedStep1()) { state.step = 2; render(); }
    });
  }

  function canProceedStep1() {
    return state.tab === 'amount' ? !!state.amount : !!state.treatment;
  }

  function loadTreatments() {
    if (!window.spaFetch) return;
    window.spaFetch('/api/widget/treatments').then(function (data) {
      state.treatments = (data.treatments || [])
        .filter(function (t) { return Number(t.price) > 0; })
        .map(function (t) {
          var cat = t.category_name || resolveCategory(t.name);
          return { id: t.id, displayName: cleanName(t.name, t.duration_minutes), price: t.price, cat: cat };
        })
        .sort(function (a, b) { return a.displayName.localeCompare(b.displayName); });
      renderBody();
    }).catch(function () {
      state.treatments = [];
      renderBody();
    });
  }

  /* ── Step 2 — Personalise ─────────────────────────────────────── */
  function renderStep2(body) {
    var vLabel = state.tab === 'amount' ? gbp(state.amount) + ' gift voucher' : state.treatment.displayName + ' voucher';
    body.innerHTML =
      '<div class="bss-v-summary">'
      + '<div><div class="bss-v-slabel">Your voucher</div><div class="bss-v-sval">' + esc(vLabel) + '</div></div>'
      + '<div class="bss-v-sprice">' + (state.tab === 'amount' ? gbp(state.amount) : gbp(state.treatment.price)) + '</div>'
      + '</div>'
      + '<div class="bss-v-field"><label>Recipient\'s name</label><input type="text" id="bss-recipient" placeholder="e.g. Emma Thompson" value="' + esc(state.recipient) + '"></div>'
      + '<div class="bss-v-field"><label>Recipient\'s email</label><input type="email" id="bss-remail" placeholder="emma@example.com" value="' + esc(state.recipientEmail) + '"></div>'
      + '<div class="bss-v-field"><label>Your name</label><input type="text" id="bss-sender" placeholder="Your name" value="' + esc(state.sender) + '"></div>'
      + '<div class="bss-v-field"><label>Personal message <span style="font-weight:400;text-transform:none;letter-spacing:0;color:' + MUTED + ';">(optional)</span></label><textarea id="bss-message" placeholder="With love…">' + esc(state.message) + '</textarea></div>'
      + '<div class="bss-v-btns">'
      + '<button class="bss-v-btn bss-v-btn-ghost" id="bss-v-back2">← Back</button>'
      + '<button class="bss-v-btn" id="bss-v-next2">Continue →</button>'
      + '</div>';

    document.getElementById('bss-v-back2').addEventListener('click', function () { state.step = 1; render(); });
    document.getElementById('bss-v-next2').addEventListener('click', function () {
      state.recipient = document.getElementById('bss-recipient').value.trim();
      state.recipientEmail = document.getElementById('bss-remail').value.trim();
      state.sender = document.getElementById('bss-sender').value.trim();
      state.message = document.getElementById('bss-message').value.trim();
      if (!state.recipient || !state.recipientEmail || !state.sender) {
        document.getElementById('bss-v-next2').textContent = 'Please fill in name + email';
        return;
      }
      state.step = 3; render();
    });
  }

  /* ── Step 3 — Mock payment ────────────────────────────────────── */
  function renderStep3(body) {
    var vLabel = state.tab === 'amount' ? gbp(state.amount) + ' gift voucher' : state.treatment.displayName + ' voucher';
    var price  = state.tab === 'amount' ? state.amount : state.treatment.price;

    body.innerHTML =
      '<div class="bss-v-summary">'
      + '<div><div class="bss-v-slabel">For ' + esc(state.recipient) + '</div><div class="bss-v-sval">' + esc(vLabel) + '</div></div>'
      + '<div class="bss-v-sprice">' + gbp(price) + '</div>'
      + '</div>'
      + '<div class="bss-v-card-demo">🔒 <strong>Demo mode</strong> — no real payment will be taken. Enter any card details to complete the demo purchase.</div>'
      + '<div class="bss-v-field"><label>Card number</label><input type="text" id="bss-cardnum" placeholder="4242 4242 4242 4242" maxlength="19"></div>'
      + '<div class="bss-v-row2">'
      + '<div class="bss-v-field"><label>Expiry</label><input type="text" id="bss-expiry" placeholder="MM / YY" maxlength="7"></div>'
      + '<div class="bss-v-field"><label>CVV</label><input type="text" id="bss-cvv" placeholder="123" maxlength="3"></div>'
      + '</div>'
      + '<div class="bss-v-field"><label>Name on card</label><input type="text" id="bss-cardholder" placeholder="' + esc(state.sender) + '" value="' + esc(state.sender) + '"></div>'
      + '<div class="bss-v-btns">'
      + '<button class="bss-v-btn bss-v-btn-ghost" id="bss-v-back3">← Back</button>'
      + '<button class="bss-v-btn bss-v-btn-gold" id="bss-v-pay">Pay ' + gbp(price) + ' →</button>'
      + '</div>';

    /* Card number formatting */
    document.getElementById('bss-cardnum').addEventListener('input', function (e) {
      var v = e.target.value.replace(/\D/g, '').slice(0, 16);
      e.target.value = v.replace(/(.{4})/g, '$1 ').trim();
    });
    document.getElementById('bss-expiry').addEventListener('input', function (e) {
      var v = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (v.length >= 2) v = v.slice(0, 2) + ' / ' + v.slice(2);
      e.target.value = v;
    });

    document.getElementById('bss-v-back3').addEventListener('click', function () { state.step = 2; render(); });
    document.getElementById('bss-v-pay').addEventListener('click', function () {
      var btn = document.getElementById('bss-v-pay');
      btn.textContent = 'Processing…';
      btn.disabled = true;

      // POST to the spa API to create a real voucher record
      var body = {
        value:           state.tab === 'amount' ? state.amount : Number(state.treatment.price),
        purchased_by:    state.sender,
        purchased_for:   state.recipient,
        recipient_email: state.recipientEmail,
        message:         state.message || null,
      };
      if (state.tab === 'treatment' && state.treatment) {
        body.treatment_id = state.treatment.id;
      }

      fetch(window.SPA_API + '/api/widget/vouchers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          state.code = (data.voucher && data.voucher.code) ? data.voucher.code : randomCode();
          state.step = 4;
          render();
        })
        .catch(function () {
          // Fallback: show success with a client-side code if API is unreachable
          state.code = randomCode();
          state.step = 4;
          render();
        });
    });
  }

  /* ── Step 4 — Success ─────────────────────────────────────────── */
  function renderStep4(body) {
    var vLabel = state.tab === 'amount' ? gbp(state.amount) + ' gift voucher' : state.treatment.displayName + ' voucher';
    var price  = state.tab === 'amount' ? state.amount : state.treatment.price;
    var expiry = new Date(); expiry.setFullYear(expiry.getFullYear() + 1);
    var expiryStr = expiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    body.innerHTML =
      '<div class="bss-v-success">'
      + '<div class="bss-v-check">✓</div>'
      + '<h3 style="font-family:\'Playfair Display\',serif;font-size:22px;color:' + NAVY + ';margin:0 0 6px;">Voucher sent!</h3>'
      + '<p style="color:' + MUTED + ';font-size:14px;margin:0 0 4px;">A confirmation has been sent to <strong style="color:' + NAVY + ';">' + esc(state.recipientEmail) + '</strong>.</p>'
      + '<div class="bss-v-voucher-card">'
      + '<div class="bss-v-vbrand">Baan Siam Spa</div>'
      + '<div style="font-size:12px;color:rgba(255,255,255,0.55);margin-bottom:8px;">47 Charlotte Street, Fitzrovia, London</div>'
      + '<div class="bss-v-vamt">' + gbp(price) + '</div>'
      + '<div style="font-size:13px;color:rgba(255,255,255,0.7);margin:4px 0 12px;">' + esc(vLabel) + '</div>'
      + '<div class="bss-v-vcode">' + esc(state.code) + '</div>'
      + '<div class="bss-v-vmeta">For: ' + esc(state.recipient) + '&nbsp;&nbsp;·&nbsp;&nbsp;Valid until: ' + esc(expiryStr) + '</div>'
      + (state.message ? '<div style="margin-top:10px;font-style:italic;font-size:13px;color:rgba(255,255,255,0.65);">"' + esc(state.message) + '"</div>' : '')
      + '</div>'
      + '<p style="font-size:13px;color:' + MUTED + ';margin:0 0 16px;">To redeem, ' + esc(state.recipient) + ' simply quotes the code when booking.</p>'
      + '<div class="bss-v-btns" style="justify-content:center;">'
      + '<button class="bss-v-btn" id="bss-v-book-now" style="max-width:220px;">Book a treatment →</button>'
      + '<button class="bss-v-btn bss-v-btn-ghost" id="bss-v-another" style="max-width:180px;">Buy another</button>'
      + '</div>'
      + '</div>';

    document.getElementById('bss-v-book-now').addEventListener('click', function () {
      close();
      if (window.SiamEPOSSpa) window.SiamEPOSSpa.open();
    });
    document.getElementById('bss-v-another').addEventListener('click', function () {
      state.step = 1; state.tab = 'amount'; state.amount = null;
      state.treatment = null; state.code = '';
      render();
    });
  }

  /* ── Public API ───────────────────────────────────────────────── */
  window.SiamEPOSSpaVoucher = { open: open };

})();
