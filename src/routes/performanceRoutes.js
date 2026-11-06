import { Router } from 'express';
import { requireAuth, requirePermission, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as performanceController from '../controllers/performanceController.js';
import { performanceQuerySchema } from '../validators/performanceSchemas.js';

// Team performance: the same people as "See performance reviews" (reviews.view, scoped)
const router = Router();
router.use(requireAuth, requireFeature('reviews'));

router.get('/', requirePermission('reviews.view'), validate(performanceQuerySchema, 'query'), performanceController.getPerformance);

export default router;
