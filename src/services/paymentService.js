// ============================================================
// Invoice payments — the most sensitive money code in Phase 2.
//
// Safety checks:
// 1. IDEMPOTENCY: the form sends a requestId. If the same requestId
//    arrives twice (double click, retry after a timeout), the payment
//    is saved ONCE and the second call returns the first payment.
//    A UNIQUE key on (organization_id, request_id) backs this up.
// 2. CONCURRENCY: the invoice row is locked (SELECT ... FOR UPDATE)
//    while a payment is recorded, so two people paying the same
//    invoice at the same moment can't both pass the balance check.
// 3. NO OVERPAYMENT: a payment can't be more than the balance.
// 4. SOURCE OF TRUTH: amount_paid is re-added from the payments
//    table each time, never just "old value + new amount".
// ============================================================
import { withTransaction } from '../config/db.js';
import * as invoiceModel from '../models/invoiceModel.js';
import * as paymentModel from '../models/paymentModel.js';
import * as customerModel from '../models/customerModel.js';
import * as auditModel from '../models/auditModel.js';
import { formatNaira, statusAfterPayment } from '../utils/money.js';
import { toDateString } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

async function refreshInvoiceTotals(invoice, db) {
  const paid = await paymentModel.sumForInvoice(invoice.id, db);
  await invoiceModel.setPaymentState(invoice.id, paid, statusAfterPayment(invoice, paid), db);
}

export async function recordPayment(auth, invoiceId, data) {
  // 1. Already saved this exact request? Return it instead of paying twice.
  if (data.requestId) {
    const existing = await paymentModel.findByRequestId(auth.orgId, data.requestId);
    if (existing) return { payment: existing, duplicate: true };
  }

  let paymentId;
  try {
    paymentId = await withTransaction(async (db) => {
      // 2. Lock the invoice until we finish
      const invoice = await invoiceModel.findById(auth.orgId, invoiceId, toDateString(), { forUpdate: true }, db);
      if (!invoice) throw new AppError(404, 'Invoice not found');
      if (invoice.status === 'void') throw new AppError(409, 'This invoice has been voided');

      // 3. No overpayment
      const balance = Number(invoice.total_kobo) - Number(invoice.amount_paid_kobo);
      if (balance <= 0) throw new AppError(409, 'This invoice is already fully paid');
      if (data.amountKobo > balance) {
        throw new AppError(422, `Payment is more than the balance of ${formatNaira(balance)}`, {
          amount: `The balance is ${formatNaira(balance)}`,
        });
      }

      const id = await paymentModel.create(
        auth.orgId,
        { ...data, invoiceId: invoice.id, customerId: invoice.customer_id, recordedBy: auth.userId },
        db
      );
      // 4. Re-add from the payments table
      await refreshInvoiceTotals(invoice, db);
      await customerModel.setStage(auth.orgId, invoice.customer_id, 'customer', auth.userId, db); // paying makes them a customer
      return id;
    });
  } catch (err) {
    // Two identical requests raced each other: the UNIQUE key stopped the second one
    if (err.code === 'ER_DUP_ENTRY' && data.requestId) {
      return { payment: await paymentModel.findByRequestId(auth.orgId, data.requestId), duplicate: true };
    }
    throw err;
  }

  const payment = await paymentModel.findById(auth.orgId, paymentId);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'payment.recorded',
    entityType: 'invoice',
    entityId: Number(invoiceId),
    details: `${payment.invoice_number}: ${formatNaira(payment.amount_kobo)} by ${payment.method}`,
  });
  return { payment, duplicate: false };
}

// For mistakes (wrong amount, wrong invoice). Recorded in the activity log.
export async function removePayment(auth, paymentId) {
  const payment = await paymentModel.findById(auth.orgId, paymentId);
  if (!payment) throw new AppError(404, 'Payment not found');

  await withTransaction(async (db) => {
    const invoice = await invoiceModel.findById(auth.orgId, payment.invoice_id, toDateString(), { forUpdate: true }, db);
    await paymentModel.remove(payment.id, db);
    await refreshInvoiceTotals(invoice, db);
  });

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'payment.removed',
    entityType: 'invoice',
    entityId: payment.invoice_id,
    details: `${payment.invoice_number}: ${formatNaira(payment.amount_kobo)} removed`,
  });
}
