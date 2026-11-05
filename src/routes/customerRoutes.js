import { Router } from 'express';
import { requireAuth, requirePermission, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as customerController from '../controllers/customerController.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersSchema,
  activitySchema,
  salesQuerySchema,
} from '../validators/crmSchemas.js';

const router = Router();
router.use(requireAuth, requireFeature('crm')); // only on plans that include crm

const view = requirePermission('customers.view');
const manage = requirePermission('customers.manage');

// Fixed paths first (before "/:id")
router.get('/', view, validate(listCustomersSchema, 'query'), customerController.list);
// Every customer's name (for the invoice form) — only for people who create invoices
router.get('/options', requirePermission('invoices.manage'), customerController.options);
router.get('/sales', view, validate(salesQuerySchema, 'query'), customerController.sales);
router.get('/follow-ups', view, customerController.followUps);
router.get('/cases', view, customerController.openCases);
router.patch('/activity/:interactionId/resolve', manage, customerController.resolveCase);
router.patch('/activity/:interactionId/follow-up-done', manage, customerController.completeFollowUp);

router.post('/', manage, validate(createCustomerSchema), customerController.create);
router.get('/:id', view, customerController.getOne);
router.patch('/:id', manage, validate(updateCustomerSchema), customerController.update);
router.get('/:id/activity', view, customerController.activity);
router.get('/:id/stages', view, customerController.stages);
router.post('/:id/activity', manage, validate(activitySchema), customerController.addActivity);
router.get('/:id/payments', view, requirePermission('invoices.view'), customerController.payments);

export default router;
