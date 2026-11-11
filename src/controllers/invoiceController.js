import asyncHandler from '../utils/asyncHandler.js';
import * as invoiceService from '../services/invoiceService.js';
import * as brandingService from '../services/brandingService.js';
import { getClientIp } from '../utils/ip.js';
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

// GET /api/invoices/:id/email-draft — a ready-to-edit email for sending from my own Gmail/Outlook
export const emailDraft = asyncHandler(async (req, res) => {
  res.json(await invoiceService.emailDraft(req.auth, req.params.id));
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

// ---------- Branding (logo, colour, signature) ----------
// GET /api/invoices/branding
export const getBranding = asyncHandler(async (req, res) => {
  res.json(await brandingService.getBranding(req.auth.orgId));
});

// PUT /api/invoices/branding  { brandColor, signatoryName, signatoryTitle }
export const updateBranding = asyncHandler(async (req, res) => {
  res.json(await brandingService.updateBranding(req.auth, req.body));
});

// POST /api/invoices/branding/logo | /signature  (multipart, field "file")
export const uploadBrandImage = asyncHandler(async (req, res) => {
  res.json(await brandingService.setImage(req.auth, req.params.kind, req.file));
});

// DELETE /api/invoices/branding/logo | /signature
export const removeBrandImage = asyncHandler(async (req, res) => {
  res.json(await brandingService.removeImage(req.auth, req.params.kind));
});

// POST /api/public/invoices/:token/accept  { name, signature, note }  (the customer, no login)
export const acceptPublic = asyncHandler(async (req, res) => {
  res.status(201).json(await brandingService.acceptInvoice(req.params.token, req.body, getClientIp(req)));
});
