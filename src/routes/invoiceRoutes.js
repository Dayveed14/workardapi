import { Router } from 'express';
import { requireAuth, requirePermission, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadImage } from '../middleware/upload.js';
import * as invoiceController from '../controllers/invoiceController.js';
import {
  invoiceSchema,
  updateInvoiceSchema,
  listInvoicesSchema,
  sendInvoiceSchema,
  paymentSchema,
  invoiceSettingsSchema,
  brandingSchema,
} from '../validators/invoiceSchemas.js';

const router = Router();
router.use(requireAuth, requireFeature('invoices')); // only on plans that include invoices

const view = requirePermission('invoices.view');
const manage = requirePermission('invoices.manage');
const payments = requirePermission('invoices.payments');

// Fixed paths first (before "/:id")
router.get('/settings', view, invoiceController.getSettings);
router.put('/settings', requirePermission('finance.manage'), validate(invoiceSettingsSchema), invoiceController.updateSettings);
router.get('/branding', view, invoiceController.getBranding);
router.put('/branding', requirePermission('finance.manage'), validate(brandingSchema), invoiceController.updateBranding);
router.post('/branding/:kind(logo|signature)', requirePermission('finance.manage'), uploadImage, invoiceController.uploadBrandImage);
router.delete('/branding/:kind(logo|signature)', requirePermission('finance.manage'), invoiceController.removeBrandImage);
router.delete('/payments/:paymentId', payments, invoiceController.removePayment);

router.get('/', view, validate(listInvoicesSchema, 'query'), invoiceController.list);
router.post('/', manage, validate(invoiceSchema), invoiceController.create);
router.get('/:id', view, invoiceController.getOne);
router.put('/:id', manage, validate(updateInvoiceSchema), invoiceController.update);
router.delete('/:id', manage, invoiceController.remove);
router.post('/:id/send', manage, validate(sendInvoiceSchema), invoiceController.send);
router.post('/:id/void', manage, invoiceController.voidInvoice);
router.post('/:id/payments', payments, validate(paymentSchema), invoiceController.recordPayment);

export default router;
