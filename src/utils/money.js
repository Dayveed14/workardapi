// ============================================================
// MONEY RULES
// - The database stores money in KOBO as whole numbers (₦1.00 = 100).
// - Forms send naira (what people type); validators convert to kobo.
// - The API returns kobo (fields end in _kobo); the frontend formats it.
// Whole numbers mean no floating-point rounding errors in totals.
// ============================================================

// 1250.5 → 125050
export const nairaToKobo = (naira) => Math.round(Number(naira) * 100);

// 125050 → "₦1,250.50"
export function formatNaira(kobo) {
  return `₦${(Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Works out every invoice amount from its items.
//   items: [{ quantity, unitPriceKobo }]
//   discountKobo: money off (before tax)
//   taxRate: percentage, e.g. 7.5 for VAT
export function calculateTotals(items, discountKobo = 0, taxRate = 0) {
  const lines = items.map((item) => ({
    ...item,
    lineTotalKobo: Math.round(Number(item.quantity) * item.unitPriceKobo),
  }));
  const subtotalKobo = lines.reduce((sum, l) => sum + l.lineTotalKobo, 0);
  const discount = Math.min(discountKobo, subtotalKobo); // can't discount below zero
  const taxableKobo = subtotalKobo - discount;
  const taxKobo = Math.round((taxableKobo * Number(taxRate)) / 100);
  return {
    lines,
    subtotalKobo,
    discountKobo: discount,
    taxKobo,
    totalKobo: taxableKobo + taxKobo,
  };
}

// Decides the invoice status from how much has been paid
export function statusAfterPayment(invoice, amountPaidKobo) {
  if (amountPaidKobo >= Number(invoice.total_kobo) && Number(invoice.total_kobo) > 0) return 'paid';
  if (amountPaidKobo > 0) return 'partially_paid';
  return invoice.sent_at ? 'sent' : 'draft';
}
