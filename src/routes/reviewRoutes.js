import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as reviewController from '../controllers/reviewController.js';
import {
  reviewSettingsSchema,
  listReviewsSchema,
  reviewablesSchema,
  startReviewsSchema,
  selfReviewSchema,
  managerReviewSchema,
  acknowledgeSchema,
} from '../validators/reviewSchemas.js';

// Everyone has their OWN reviews, so most routes need only a login.
// Who may see / write each review is checked in reviewService (scopes + direct manager).
const router = Router();
router.use(requireAuth);

// Fixed paths first (before "/:id")
router.get('/settings', reviewController.getSettings);
router.put('/settings', requirePermission('reviews.setup'), validate(reviewSettingsSchema), reviewController.updateSettings);
router.get('/reviewables', validate(reviewablesSchema, 'query'), reviewController.reviewables);
router.post('/start', validate(startReviewsSchema), reviewController.start);
router.get('/', validate(listReviewsSchema, 'query'), reviewController.list);

router.get('/:id', reviewController.getOne);
router.put('/:id/self', validate(selfReviewSchema), reviewController.saveSelf);
router.post('/:id/skip-self', reviewController.skipSelf);
router.put('/:id/manager', validate(managerReviewSchema), reviewController.saveManager);
router.post('/:id/acknowledge', validate(acknowledgeSchema), reviewController.acknowledge);
router.post('/:id/cancel', reviewController.cancel);

export default router;
