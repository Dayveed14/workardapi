import asyncHandler from '../utils/asyncHandler.js';
import * as invoiceService from '../services/invoiceService.js';
import * as paymentService from '../services/paymentService.js';

// GET /api/invoices?filter=unpaid&customerId=&search=&page=
export const list = asyncHandler(async (req, res) => {
  res.json(await invoiceService.listInvoices(req.auth, req.validatedQuery));
});

// GET /api/invoices/:id  (with items, payments, bank details)
export const getOne = asyncHandler(async (req, res) => {
  res.json(await invoiceService.getInvoice(req.auth, req.params.id));
});

// POST /api/invoices
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await invoiceService.createInvoice(req.auth, req.body));
});

// PUT /api/invoices/:id
export const update = asyncHandler(async (req, res) => {
  res.json(await invoiceService.updateInvoice(req.auth, req.params.id, req.body));
});

// POST /api/invoices/:id/send  { channel: 'email' | 'whatsapp' | 'link' }
export const send = asyncHandler(async (req, res) => {
  res.json(await invoiceService.sendInvoice(req.auth, req.params.id, req.body));
});

// POST /api/invoices/:id/void
export const voidInvoice = asyncHandler(async (req, res) => {
  res.json(await invoiceService.voidInvoice(req.auth, req.params.id));
});

// DELETE /api/invoices/:id  (drafts only)
export const remove = asyncHandler(async (req, res) => {
  await invoiceService.deleteInvoice(req.auth, req.params.id);
  res.json({ message: 'Draft deleted' });
});

// POST /api/invoices/:id/payments
export const recordPayment = asyncHandler(async (req, res) => {
  const result = await paymentService.recordPayment(req.auth, req.params.id, req.body);
  res.status(result.duplicate ? 200 : 201).json(result);
});

// DELETE /api/invoices/payments/:paymentId
export const removePayment = asyncHandler(async (req, res) => {
  await paymentService.removePayment(req.auth, req.params.paymentId);
  res.json({ message: 'Payment removed' });
});

// GET /api/invoices/settings
export const getSettings = asyncHandler(async (req, res) => {
  res.json(await invoiceService.getSettings(req.auth.orgId));
});

// PUT /api/invoices/settings
export const updateSettings = asyncHandler(async (req, res) => {
  res.json(await invoiceService.updateSettings(req.auth, req.body));
});

// GET /api/public/invoices/:token  (no login — the customer's view)
export const getPublic = asyncHandler(async (req, res) => {
  res.json(await invoiceService.getPublicInvoice(req.params.token));
});
