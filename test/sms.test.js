// SPA-SMS-COST-001 — every text must be ONE GSM-7 segment (≤160 chars, no
// UCS-2 trigger). Standalone — no test framework:
//   node test/sms.test.js
'use strict';
const { toGsm7, smsBody, buildBookingSmsText } = require('../src/services/emailService');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
}
const GSM_OK = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[~\]|€]*$/;

console.log('toGsm7:');
eq('em-dash → hyphen', toGsm7('booking confirmed — Thai'), 'booking confirmed - Thai');
eq('en-dash → hyphen', toGsm7('10–11'), '10-11');
eq('curly quotes → straight', toGsm7('“hi” it’s'), '"hi" it\'s');
eq('emoji dropped', toGsm7('💬 New chat'), 'New chat');
eq('Thai dropped, latin kept', toGsm7('นวดไทย Thai Massage'), 'Thai Massage');
eq('accent stripped (á→a)', toGsm7('Fábio'), 'Fabio');
eq('GSM accent kept (é)', toGsm7('café'), 'café');
eq('ellipsis', toGsm7('wait…'), 'wait...');

console.log('smsBody:');
eq('caps at 160', smsBody('x'.repeat(200)).length, 160);
eq('extension char counts 2', smsBody('€'.repeat(100)).length, 80);

console.log('buildBookingSmsText:');
const starts = '2026-09-01T13:00:00Z'; // 14:00 BST
const t = buildBookingSmsText({ spaName: 'Highbury Thai Massage', treatmentName: 'Traditional Thai Massage 60 min', starts_at: starts, id: 1234 });
eq('short body', t, 'Highbury Thai Massage: booking confirmed - Traditional Thai Massage 60 min, Tue 1 Sept, 14:00. Ref #1234.');
eq('is pure GSM', GSM_OK.test(t), true);
eq('one segment', t.length <= 160, true);
const long = buildBookingSmsText({ spaName: 'Highbury Thai Massage', treatmentName: 'Deluxe Aromatherapy Full Body Hot Oil Massage with Herbal Compress and Head, Neck & Shoulder Add-on – 120 minutes couples room', starts_at: starts, id: 98765 });
eq('long treatment name still ≤160', long.length <= 160, true);
eq('long: ref survives', /Ref #98765\.$/.test(long), true);
eq('long: date survives', long.includes('Tue 1 Sept, 14:00'), true);
const dashy = buildBookingSmsText({ spaName: 'Jinta’s Spa — Soho', treatmentName: 'Thai — 60', starts_at: starts, id: 7 });
eq('spa name with dash/curly is GSM', GSM_OK.test(dashy), true);
eq('spa name sanitised', dashy.startsWith("Jinta's Spa - Soho: booking confirmed - Thai - 60,"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
