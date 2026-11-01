import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as leaveController from '../controllers/leaveController.js';
import { leaveListSchema } from '../validators/attendanceLeaveSchemas.js';
import { reviewSchema } from '../validators/common.js';

const router = Router();
router.use(requireAuth);

router.get('/', requirePermission('leave.view'), validate(leaveListSchema, 'query'), leaveController.list);
router.patch('/:id/review', requirePermission('leave.approve'), validate(reviewSchema), leaveController.review);

export default router;
