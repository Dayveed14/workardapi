// ============================================================
// PAYING SALARIES THROUGH PAYSTACK
// Uses the business's own Paystack account. Money goes from their
// Paystack balance straight to each employee's bank account.
//
// Safety checks:
// 1. Only an APPROVED run can be paid. Bank details were frozen at approval.
// 2. Every payslip gets its own transfer REFERENCE, saved before anything is
//    sent. A retry re-uses the same reference, and Paystack treats a repeated
//    reference as the same transfer — so a retry can never pay someone twice.
// 3. The run is locked while payslips are marked "processing", so a double
//    click (or two people) can't send the same payslips twice.
// 4. Paystack's answer comes later by WEBHOOK (transfer.success / failed /
//    reversed). The webhook's signature is checked with the business's key.
// 5. Expenses are recorded only when EVERY payslip is paid (and only once).
// ============================================================
import crypto from 'node:crypto';
import { withTransaction } from '../config/db.js';
import * as payrollRunModel from '../models/payrollRunModel.js';
import * as payrollSettingsModel from '../models/payrollSettingsModel.js';
import * as employeePayModel from '../models/employeePayModel.js';
import * as auditModel from '../models/auditModel.js';
import * as paystackService from './paystackService.js';
import { afterPaid } from './payrollService.js';
import { decrypt } from '../utils/encryption.js';
import { formatNaira } from '../utils/money.js';
import AppError from '../utils/AppError.js';

const BATCH_SIZE = 100; // Paystack's limit per bulk request

async function getSecretKey(orgId) {
  const settings = await payrollSettingsModel.get(orgId);
  if (!settings.paystack_secret_enc) return null;
  return decrypt(settings.paystack_secret_enc);
}

export async function listBanks(orgId) {
  const key = await getSecretKey(orgId);
  if (!key) throw new AppError(409, 'Connect Paystack in Settings → Payroll to load the bank list');
  return paystackService.listBanks(key);
}

export async function verifyAccount(orgId, { accountNumber, bankCode }) {
  const key = await getSecretKey(orgId);
  if (!key) throw new AppError(409, 'Connect Paystack in Settings → Payroll to check account numbers');
  return paystackService.resolveAccount(key, accountNumber, bankCode);
}

export async function payWithPaystack(auth, runId) {
  const key = await getSecretKey(auth.orgId);
  if (!key) throw new AppError(409, 'Connect Paystack in Settings → Payroll first');

  // Step 1 (locked): choose who to pay, give each a reference, mark them "processing"
  const toPay = await withTransaction(async (db) => {
    const run = await payrollRunModel.findById(auth.orgId, runId, { forUpdate: true }, db);
    if (!run) throw new AppError(404, 'Payroll run not found');
    if (!['approved', 'processing'].includes(run.status)) throw new AppError(409, 'Approve the payroll before paying it');

    const items = (await payrollRunModel.listItems(run.id, db)).filter((i) => ['pending', 'failed'].includes(i.payment_status));
    if (!items.length) throw new AppError(409, 'Nothing left to pay on this payroll');

    const missing = items.filter((i) => !i.account_number || !i.bank_code).map((i) => `${i.first_name} ${i.last_name}`);
    if (missing.length) {
      throw new AppError(422, `Bank details (with bank chosen from the list) are missing for: ${missing.join(', ')}. Add them on the Pay tab, then cancel and redo this payroll — or pay these people by bank upload.`);
    }

    for (const item of items) {
      // Keep an existing reference on retry — that's what stops a double payment
      const reference = item.transfer_reference || `wkpay_${crypto.randomBytes(12).toString('hex')}`;
      await payrollRunModel.setItemPayment(item.id, { payment_status: 'processing', transfer_reference: reference, failure_reason: null }, db);
      item.transfer_reference = reference;
    }
    await payrollRunModel.setStatus(run.id, 'processing', { payment_method: 'paystack' }, db);
    return { run, items };
  });

  // Step 2 (outside the lock — network calls): make sure each person is a Paystack recipient
  const ready = [];
  for (const item of toPay.items) {
    try {
      let recipient = item.paystack_recipient_code;
      if (!recipient) {
        recipient = await paystackService.createRecipient(key, {
          name: item.account_name || `${item.first_name} ${item.last_name}`,
          accountNumber: item.account_number,
          bankCode: item.bank_code,
        });
        await employeePayModel.setRecipientCode(item.employee_id, recipient);
      }
      ready.push({ item, recipient });
    } catch (err) {
      await payrollRunModel.setItemPayment(item.id, { payment_status: 'failed', failure_reason: err.message.slice(0, 255) });
    }
  }

  // Step 3: send in batches of 100
  for (let i = 0; i < ready.length; i += BATCH_SIZE) {
    const batch = ready.slice(i, i + BATCH_SIZE);
    try {
      const results = await paystackService.bulkTransfer(
        key,
        batch.map(({ item, recipient }) => ({
          amount: Number(item.net_kobo),
          recipient,
          reference: item.transfer_reference,
          reason: `Salary ${toPay.run.period}`,
        }))
      );
      for (const r of results || []) {
        const match = batch.find((b) => b.item.transfer_reference === r.reference);
        if (!match) continue;
        // Test keys answer "success" straight away; live transfers confirm later by webhook
        const fields = { transfer_code: r.transfer_code || null };
        if (r.status === 'success') Object.assign(fields, { payment_status: 'paid', paid_at: new Date() });
        if (r.status === 'failed') Object.assign(fields, { payment_status: 'failed', failure_reason: 'Rejected by Paystack' });
        await payrollRunModel.setItemPayment(match.item.id, fields);
      }
    } catch (err) {
      // The whole batch was refused — mark it failed (references kept for a safe retry)
      for (const { item } of batch) {
        await payrollRunModel.setItemPayment(item.id, { payment_status: 'failed', failure_reason: err.message.slice(0, 255) });
      }
    }
  }

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'payroll.paystack_sent',
    entityType: 'payroll',
    entityId: toPay.run.id,
    details: `${toPay.run.period}: ${toPay.items.length} transfer(s), ${formatNaira(toPay.items.reduce((s, x) => s + Number(x.net_kobo), 0))}`,
  });

  await completeIfAllPaid(auth.orgId, toPay.run.id, auth.userId);
  return payrollRunModel.findById(auth.orgId, toPay.run.id);
}

// When every payslip is paid, the run is paid → expenses + payslip emails
async function completeIfAllPaid(orgId, runId, userId = null) {
  const done = await withTransaction(async (db) => {
    const run = await payrollRunModel.findById(orgId, runId, { forUpdate: true }, db);
    if (!run || run.status !== 'processing') return false;
    const items = await payrollRunModel.listItems(run.id, db);
    if (!items.every((i) => i.payment_status === 'paid')) return false;
    await payrollRunModel.setStatus(run.id, 'paid', { paid_at: new Date() }, db);
    return true;
  });
  if (done) await afterPaid(orgId, runId, userId);
}

// ---------- Webhook from Paystack ----------
// POST /api/webhooks/paystack/:orgId  (raw body — needed to check the signature)
export async function handleWebhook(orgId, rawBody, signature) {
  const key = await getSecretKey(orgId);
  if (!key || !paystackService.isValidSignature(rawBody, signature, key)) {
    throw new AppError(401, 'Invalid signature');
  }

  const event = JSON.parse(rawBody.toString('utf8'));
  if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event)) return; // not ours

  const item = await payrollRunModel.findItemByReference(event.data?.reference);
  if (!item || item.organization_id !== Number(orgId)) return; // not a payroll transfer

  if (event.event === 'transfer.success') {
    if (item.payment_status !== 'paid') {
      await payrollRunModel.setItemPayment(item.id, { payment_status: 'paid', paid_at: new Date(), failure_reason: null });
    }
  } else {
    // failed, or reversed (money came back) — can be retried with the same reference
    await payrollRunModel.setItemPayment(item.id, {
      payment_status: 'failed',
      failure_reason: event.event === 'transfer.reversed' ? 'Reversed by the bank' : event.data?.reason || 'Transfer failed',
    });
  }

  await auditModel.log({
    orgId: Number(orgId),
    action: `payroll.${event.event.replace('.', '_')}`,
    entityType: 'payroll',
    entityId: item.run_id,
    details: `${item.first_name} ${item.last_name}: ${formatNaira(item.net_kobo)}`,
  });
  await completeIfAllPaid(Number(orgId), item.run_id);
}
