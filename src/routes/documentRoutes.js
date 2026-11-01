import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as documentController from '../controllers/documentController.js';

const router = Router();
router.use(requireAuth);

// The service checks documents.manage for the document's employee
router.delete('/:documentId', documentController.remove);

export default router;
