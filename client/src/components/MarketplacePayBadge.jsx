// SPA-TREATWELL-PREPAID-001 — say in words whether a Treatwell / Fresha
// booking is already paid. The timetable colour (cyan = prepaid) was the only
// signal, so the shop didn't know Jordan Robles had prepaid £75 on Treatwell
// (Highbury, 8 Nov 2026). treatwell_payment_type comes from the import:
// 'full' = the marketplace took the full price, 'partial' = deposit only,
// 'unpaid' = pay at venue.
export default function MarketplacePayBadge({ appt, amount, style }) {
  if (!appt || !['treatwell', 'fresha'].includes(appt.source)) return null;
  if (appt.payment_method) return null;   // bill already closed — the "Paid by" badge says how
  const mkt = appt.source === 'fresha' ? 'Fresha' : 'Treatwell';
  const amt = Number(amount ?? appt.price_at_booking);
  const money = Number.isFinite(amt) && amt > 0 ? ` £${amt.toFixed(2)}` : '';
  const type = appt.treatwell_payment_type;

  let look;
  if (type === 'full') {
    look = { bg: '#dcfce7', border: '#86efac', color: '#14532d',
      text: <>✅ <strong>PREPAID{money} on {mkt}</strong> — the customer has already paid. Don't take money at the till.</> };
  } else if (type === 'unpaid') {
    look = { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b',
      text: <>⚠️ <strong>NOT paid</strong> — {mkt} took no money. Collect{money} at the till.</> };
  } else if (type === 'partial') {
    look = { bg: '#fef3c7', border: '#fcd34d', color: '#92400e',
      text: <>💷 <strong>Deposit only</strong> paid on {mkt} — collect the balance at the till.</> };
  } else {
    return null;
  }
  return (
    <div style={{ background: look.bg, border: `1px solid ${look.border}`, color: look.color,
      borderRadius: 8, padding: '8px 12px', fontSize: 13, lineHeight: 1.5, ...style }}>
      {look.text}
    </div>
  );
}
