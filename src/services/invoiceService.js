import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import * as invoiceModel from '../models/invoiceModel.js';
import * as customerModel from '../models/customerModel.js';
import * as paymentModel from '../models/paymentModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import { sendEmail, invoiceEmail } from './emailService.js';
import { randomToken } from './tokenService.js';
import { calculateTotals, formatNaira } from '../utils/money.js';
import { toDateString, addDays, formatDateLong } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

const today = () => toDateString();

// ---------- Settings ----------
export async function getSettings(orgId) {
  return invoiceModel.getSettings(orgId);
}

export async function updateSettings(auth, data) {
  await invoiceModel.updateSettings(auth.orgId, data);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'invoice_settings.updated' });
  return invoiceModel.getSettings(auth.orgId);
}

// ---------- Reading ----------
export async function listInvoices(auth, query) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  const [{ rows, total }, summary] = await Promise.all([
    invoiceModel.list(auth.orgId, today(), { ...query, limit, offset: (page - 1) * limit }),
    invoiceModel.summary(auth.orgId, today()),
  ]);
  return { invoices: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)), summary };
}

async function getInvoiceOrFail(orgId, id) {
  const invoice = await invoiceModel.findById(orgId, id, today());
  if (!invoice) throw new AppError(404, 'Invoice not found');
  return invoice;
}

// Invoice + its lines, payments, and what prints on it (business name, bank details)
export async function getInvoice(auth, id) {
  const invoice = await getInvoiceOrFail(auth.orgId, id);
  const [items, payments, settings, organization] = await Promise.all([
    invoiceModel.getItems(invoice.id),
    paymentModel.listByInvoice(auth.orgId, invoice.id),
    invoiceModel.getSettings(auth.orgId),
    organizationModel.findById(auth.orgId),
  ]);
  return {
    ...invoice,
    items,
    payments,
    business: { name: organization.name, ...pickBank(settings) },
    publicUrl: invoice.public_token ? `${env.clientUrls[0]}/i/${invoice.public_token}` : null,
  };
}

function pickBank(settings) {
  return {
    bankName: settings.bank_name,
    accountName: settings.account_name,
    accountNumber: settings.account_number,
    footerNote: settings.footer_note,
  };
}

// ---------- Creating & editing ----------
async function checkCustomer(orgId, customerId) {
  const customer = await customerModel.findById(orgId, customerId);
  if (!customer) throw new AppError(422, 'Customer not found', { customerId: 'Choose a customer' });
  return customer;
}

export async function createInvoice(auth, data) {
  await checkCustomer(auth.orgId, data.customerId);
  const settings = await invoiceModel.getSettings(auth.orgId);
  const issueDate = data.issueDate || today();
  const dueDate = data.dueDate || addDays(issueDate, settings.default_due_days);
  if (dueDate < issueDate) throw new AppError(422, 'Due date cannot be before the issue date', { dueDate: 'Must be on or after the issue date' });

  const totals = calculateTotals(data.items, data.discountKobo, data.taxRate);

  // Number + invoice + lines are saved together (all or nothing)
  const id = await withTransaction(async (db) => {
    const invoiceNumber = await invoiceModel.takeNextNumber(auth.orgId, db);
    const newId = await invoiceModel.create(
      auth.orgId,
      { ...data, ...totals, issueDate, dueDate, invoiceNumber, createdBy: auth.userId },
      db
    );
    await invoiceModel.replaceItems(newId, totals.lines, db);
    return newId;
  });

  const invoice = await getInvoiceOrFail(auth.orgId, id);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: id,
    details: `${invoice.invoice_number} · ${invoice.customer_name} · ${formatNaira(invoice.total_kobo)}`,
  });
  return getInvoice(auth, id);
}

export async function updateInvoice(auth, id, data) {
  const invoice = await getInvoiceOrFail(auth.orgId, id);
  if (['paid', 'void'].includes(invoice.status) || Number(invoice.amount_paid_kobo) > 0) {
    throw new AppError(409, 'Invoices with payments cannot be edited. Void it and create a new one.');
  }
  await checkCustomer(auth.orgId, data.customerId);
  if (data.dueDate < data.issueDate) throw new AppError(422, 'Due date cannot be before the issue date', { dueDate: 'Must be on or after the issue date' });

  const totals = calculateTotals(data.items, data.discountKobo, data.taxRate);
  await withTransaction(async (db) => {
    await invoiceModel.updateDetails(auth.orgId, id, { ...data, ...totals }, db);
    await invoiceModel.replaceItems(id, totals.lines, db);
  });

  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'invoice.updated', entityType: 'invoice', entityId: id, details: invoice.invoice_number });
  return getInvoice(auth, id);
}

// ---------- Sending ----------
// Nigerian numbers: "0803 123 4567" → "2348031234567" for WhatsApp links
function toWhatsAppNumber(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  return digits;
}

// channel: "email" (we send it), "whatsapp" or "link" (we return a link to share)
export async function sendInvoice(auth, id, { channel }) {
  const invoice = await getInvoiceOrFail(auth.orgId, id);
  if (invoice.status === 'void') throw new AppError(409, 'This invoice has been voided');
  if (channel === 'email' && !invoice.customer_email) {
    throw new AppError(422, 'This customer has no email address. Add one, or share by WhatsApp.');
  }

  const token = invoice.public_token || randomToken(16);
  await invoiceModel.markSent(invoice.id, {
    token,
    when: new Date(),
    status: invoice.status === 'draft' ? 'sent' : invoice.status,
  });
  if (['lead', 'prospect'].includes((await customerModel.findById(auth.orgId, invoice.customer_id))?.stage)) {
    await customerModel.update(auth.orgId, invoice.customer_id, { stage: 'customer' });
  }

  const organization = await organizationModel.findById(auth.orgId);
  const publicUrl = `${env.clientUrls[0]}/i/${token}`;
  const balance = formatNaira(invoice.total_kobo - invoice.amount_paid_kobo);
  const dueText = formatDateLong(invoice.due_date);

  if (channel === 'email') {
    await sendEmail({
      to: invoice.customer_email,
      ...invoiceEmail({
        businessName: organization.name,
        customerName: invoice.customer_contact || invoice.customer_name,
        invoiceNumber: invoice.invoice_number,
        amount: balance,
        dueDate: dueText,
        link: publicUrl,
      }),
    });
  }

  const message =
    `Hello ${invoice.customer_contact || invoice.customer_name}, here is invoice ${invoice.invoice_number} ` +
    `from ${organization.name} for ${balance}, due ${dueText}. View it here: ${publicUrl}`;

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'invoice.sent',
    entityType: 'invoice',
    entityId: invoice.id,
    details: `${invoice.invoice_number} by ${channel}`,
  });

  return {
    message: channel === 'email' ? `Invoice emailed to ${invoice.customer_email}` : 'Invoice marked as sent',
    publicUrl,
    whatsappUrl: `https://wa.me/${toWhatsAppNumber(invoice.customer_phone)}?text=${encodeURIComponent(message)}`,
  };
}

// ---------- Void & delete ----------
export async function voidInvoice(auth, id) {
  const invoice = await getInvoiceOrFail(auth.orgId, id);
  if (invoice.status === 'void') throw new AppError(409, 'Already voided');
  if (Number(invoice.amount_paid_kobo) > 0) throw new AppError(409, 'Remove the payments on this invoice before voiding it');
  await invoiceModel.markVoid(invoice.id, new Date());
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'invoice.voided', entityType: 'invoice', entityId: id, details: invoice.invoice_number });
  return getInvoice(auth, id);
}

// Only drafts can be deleted — anything sent stays on record (void it instead)
export async function deleteInvoice(auth, id) {
  const invoice = await getInvoiceOrFail(auth.orgId, id);
  if (invoice.status !== 'draft') throw new AppError(409, 'Only draft invoices can be deleted. Void sent invoices instead.');
  await invoiceModel.remove(auth.orgId, id);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'invoice.deleted', entityType: 'invoice', entityId: id, details: invoice.invoice_number });
}

// ---------- Public link (customer view, no login) ----------
export async function getPublicInvoice(token) {
  const invoice = await invoiceModel.findByToken(token, today());
  if (!invoice) throw new AppError(404, 'Invoice not found');
  await invoiceModel.markViewed(invoice.id, new Date());

  const [items, settings, organization] = await Promise.all([
    invoiceModel.getItems(invoice.id),
    invoiceModel.getSettings(invoice.organization_id),
    organizationModel.findById(invoice.organization_id),
  ]);

  // Only what the customer should see — no internal ids or notes about staff
  return {
    invoice_number: invoice.invoice_number,
    display_status: invoice.display_status,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    subtotal_kobo: invoice.subtotal_kobo,
    discount_kobo: invoice.discount_kobo,
    tax_rate: invoice.tax_rate,
    tax_kobo: invoice.tax_kobo,
    total_kobo: invoice.total_kobo,
    amount_paid_kobo: invoice.amount_paid_kobo,
    balance_kobo: invoice.balance_kobo,
    notes: invoice.notes,
    customer_name: invoice.customer_name,
    customer_contact: invoice.customer_contact,
    customer_email: invoice.customer_email,
    customer_phone: invoice.customer_phone,
    customer_address: invoice.customer_address,
    items: items.map(({ description, quantity, unit_price_kobo, line_total_kobo }) => ({
      description,
      quantity,
      unit_price_kobo,
      line_total_kobo,
    })),
    business: { name: organization.name, ...pickBank(settings) },
  };
}
