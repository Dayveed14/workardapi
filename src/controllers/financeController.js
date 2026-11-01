import asyncHandler from '../utils/asyncHandler.js';
import * as financeService from '../services/financeService.js';

// GET /api/finance/summary?month=2026-11  (monthly report)
export const summary = asyncHandler(async (req, res) => {
  res.json(await financeService.getSummary(req.auth.orgId, req.validatedQuery.month));
});

// GET /api/finance/entries?month=&type=&categoryId=
export const entries = asyncHandler(async (req, res) => {
  res.json(await financeService.listEntries(req.auth.orgId, req.validatedQuery));
});

// GET /api/finance/payments?month=  (invoice payments received that month)
export const payments = asyncHandler(async (req, res) => {
  res.json(await financeService.listInvoicePayments(req.auth.orgId, req.validatedQuery.month));
});

// POST /api/finance/entries
export const createEntry = asyncHandler(async (req, res) => {
  res.status(201).json(await financeService.createEntry(req.auth, req.body));
});

// DELETE /api/finance/entries/:id
export const deleteEntry = asyncHandler(async (req, res) => {
  await financeService.deleteEntry(req.auth, req.params.id);
  res.json({ message: 'Entry deleted' });
});

// POST /api/finance/entries/:id/receipt  (multipart "file")
export const uploadReceipt = asyncHandler(async (req, res) => {
  res.json(await financeService.uploadReceipt(req.auth, req.params.id, req.file));
});

// GET /api/finance/categories
export const categories = asyncHandler(async (req, res) => {
  res.json(await financeService.listCategories(req.auth.orgId));
});

export const createCategory = asyncHandler(async (req, res) => {
  res.status(201).json(await financeService.createCategory(req.auth, req.body));
});

export const updateCategory = asyncHandler(async (req, res) => {
  res.json(await financeService.updateCategory(req.auth, req.params.id, req.body));
});
