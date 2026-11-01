import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as payrollController from '../controllers/payrollController.js';
import {
  createRunSchema,
  adjustItemSchema,
  markPaidSchema,
  payrollSettingsSchema,
  paystackKeySchema,
  verifyAccountSchema,
} from '../validators/payrollSchemas.js';

const router = Router();
router.use(requireAuth);

const view = requirePermission('payroll.view');
const manage = requirePermission('payroll.manage');
const approve = requirePermission('payroll.approve');

// Fixed paths first (before "/:id")
router.get('/settings', view, payrollController.getSettings);
router.put('/settings', manage, validate(payrollSettingsSchema), payrollController.updateSettings);
router.post('/settings/paystack', approve, validate(paystackKeySchema), payrollController.connectPaystack);
router.delete('/settings/paystack', approve, payrollController.disconnectPaystack);
router.get('/banks', manage, payrollController.banks);
router.post('/verify-account', manage, validate(verifyAccountSchema), payrollController.verifyAccount);
router.get('/payslips/:itemId', payrollController.payslip); // own payslip, or payroll.view (checked in service)
router.patch('/items/:itemId', manage, validate(adjustItemSchema), payrollController.adjustItem);

router.get('/', view, payrollController.list);
router.post('/', manage, validate(createRunSchema), payrollController.create);
router.get('/:id', view, payrollController.getOne);
router.post('/:id/recalculate', manage, payrollController.recalculate);
router.post('/:id/approve', approve, payrollController.approve);
router.post('/:id/cancel', manage, payrollController.cancel);
router.post('/:id/mark-paid', approve, validate(markPaidSchema), payrollController.markPaid);
router.post('/:id/pay-paystack', approve, payrollController.payWithPaystack);
router.get('/:id/bank-schedule', approve, payrollController.bankSchedule);
router.get('/:id/remittances', view, payrollController.remittances);

export default router;
