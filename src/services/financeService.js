import * as financeModel from '../models/financeModel.js';
import * as invoiceModel from '../models/invoiceModel.js';
import * as paymentModel from '../models/paymentModel.js';
import * as auditModel from '../models/auditModel.js';
import { uploadFile, deleteFile } from './uploadService.js';
import { formatNaira } from '../utils/money.js';
import { monthRange, lastMonths, toDateString } from '../utils/dates.js';
import AppError from '../utils/AppError.js';

// ---------- Categories ----------
export async function listCategories(orgId) {
  return financeModel.listCategories(orgId);
}

export async function createCategory(auth, data) {
  const id = await financeModel.createCategory(auth.orgId, data);
  return financeModel.findCategory(auth.orgId, id);
}

export async function updateCategory(auth, id, data) {
  if (!(await financeModel.findCategory(auth.orgId, id))) throw new AppError(404, 'Category not found');
  await financeModel.updateCategory(auth.orgId, id, data);
  return financeModel.findCategory(auth.orgId, id);
}

// ---------- Income & expense entries ----------
export async function listEntries(orgId, { month, type, categoryId }) {
  const { from, to } = monthRange(month);
  return financeModel.listEntries(orgId, { from, to, type, categoryId });
}

// Invoice payments for the month (shown alongside other income)
export async function listInvoicePayments(orgId, month) {
  const { from, to } = monthRange(month);
  return paymentModel.listForMonth(orgId, from, to);
}

export async function createEntry(auth, data) {
  // Same request saved twice (double click / retry)? Return the first one.
  if (data.requestId) {
    const existing = await financeModel.findEntryByRequestId(auth.orgId, data.requestId);
    if (existing) return existing;
  }

  const category = await financeModel.findCategory(auth.orgId, data.categoryId);
  if (!category || !category.is_active || category.type !== data.type) {
    throw new AppError(422, 'Choose a valid category', { categoryId: `Choose an ${data.type} category` });
  }

  let id;
  try {
    id = await financeModel.createEntry(auth.orgId, { ...data, recordedBy: auth.userId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && data.requestId) return financeModel.findEntryByRequestId(auth.orgId, data.requestId);
    throw err;
  }

  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: `${data.type}.recorded`,
    entityType: 'finance_entry',
    entityId: id,
    details: `${category.name}: ${formatNaira(data.amountKobo)} — ${data.description}`,
  });
  return financeModel.findEntry(auth.orgId, id);
}

export async function deleteEntry(auth, id) {
  const entry = await financeModel.findEntry(auth.orgId, id);
  if (!entry) throw new AppError(404, 'Entry not found');
  // Salaries & pension come from a paid payroll — deleting them here would make profit wrong
  if (entry.request_id?.startsWith('payroll-')) {
    throw new AppError(400, 'This cost was recorded by payroll and can’t be deleted here.');
  }
  await financeModel.removeEntry(entry.id);
  await deleteFile(entry.receipt_public_id, entry.receipt_type || 'image');
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: `${entry.type}.deleted`,
    entityType: 'finance_entry',
    entityId: entry.id,
    details: `${entry.category_name}: ${formatNaira(entry.amount_kobo)} — ${entry.description}`,
  });
}

export async function uploadReceipt(auth, id, file) {
  if (!file) throw new AppError(422, 'Choose a file to upload');
  const entry = await financeModel.findEntry(auth.orgId, id);
  if (!entry) throw new AppError(404, 'Entry not found');

  const uploaded = await uploadFile(file, { orgId: auth.orgId, subfolder: 'receipts' });
  await financeModel.setReceipt(entry.id, uploaded);
  await deleteFile(entry.receipt_public_id, entry.receipt_type || 'image'); // replace the old one
  return financeModel.findEntry(auth.orgId, id);
}

// ---------- Monthly report ----------
// Revenue = invoice payments received + other income (money actually IN this month).
// Profit  = revenue − expenses. (Cash basis: counted when money moves.)
export async function getSummary(orgId, month) {
  const selected = month || toDateString().slice(0, 7);
  const { from, to } = monthRange(selected);

  const months = lastMonths(selected, 6);
  const trendFrom = monthRange(months[0]).from;

  const [
    invoicePayments,
    incomeByCategory,
    expensesByCategory,
    invoiced,
    topCustomers,
    receivables,
    monthlyPayments,
    monthlyIncome,
    monthlyExpenses,
  ] = await Promise.all([
    financeModel.invoicePaymentsTotal(orgId, from, to),
    financeModel.totalsByCategory(orgId, 'income', from, to),
    financeModel.totalsByCategory(orgId, 'expense', from, to),
    financeModel.invoicedTotal(orgId, from, to),
    financeModel.topCustomers(orgId, from, to),
    invoiceModel.summary(orgId, toDateString()),
    financeModel.monthlyInvoicePayments(orgId, trendFrom, to),
    financeModel.monthlyEntries(orgId, 'income', trendFrom, to),
    financeModel.monthlyEntries(orgId, 'expense', trendFrom, to),
  ]);

  const otherIncome = incomeByCategory.reduce((s, c) => s + c.totalKobo, 0);
  const expenses = expensesByCategory.reduce((s, c) => s + c.totalKobo, 0);
  const revenue = invoicePayments + otherIncome;

  return {
    month: selected,
    revenueKobo: revenue,
    invoicePaymentsKobo: invoicePayments,
    otherIncomeKobo: otherIncome,
    expensesKobo: expenses,
    profitKobo: revenue - expenses,
    profitMargin: revenue ? Math.round(((revenue - expenses) / revenue) * 100) : null,
    invoiced,
    receivables,
    incomeByCategory,
    expensesByCategory,
    topCustomers,
    trend: months.map((m) => {
      const income = (monthlyPayments[m] || 0) + (monthlyIncome[m] || 0);
      const expense = monthlyExpenses[m] || 0;
      return { month: m, incomeKobo: income, expensesKobo: expense, profitKobo: income - expense };
    }),
  };
}
