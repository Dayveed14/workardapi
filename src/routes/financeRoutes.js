import { Router } from 'express';
import { requireAuth, requirePermission, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadDocument } from '../middleware/upload.js';
import * as financeController from '../controllers/financeController.js';
import {
  monthQuerySchema,
  entriesQuerySchema,
  entrySchema,
  categorySchema,
  updateCategorySchema,
} from '../validators/financeSchemas.js';

const router = Router();
router.use(requireAuth, requireFeature('finance')); // only on plans that include finance

const view = requirePermission('finance.view');
const manage = requirePermission('finance.manage');

router.get('/summary', view, validate(monthQuerySchema, 'query'), financeController.summary);
router.get('/payments', view, validate(monthQuerySchema, 'query'), financeController.payments);

router.get('/entries', view, validate(entriesQuerySchema, 'query'), financeController.entries);
router.post('/entries', manage, validate(entrySchema), financeController.createEntry);
router.delete('/entries/:id', manage, financeController.deleteEntry);
router.post('/entries/:id/receipt', manage, uploadDocument, financeController.uploadReceipt);

router.get('/categories', view, financeController.categories);
router.post('/categories', manage, validate(categorySchema), financeController.createCategory);
router.put('/categories/:id', manage, validate(updateCategorySchema), financeController.updateCategory);

export default router;
