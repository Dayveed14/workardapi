import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as attendanceController from '../controllers/attendanceController.js';
import { registerQuerySchema, monthQuerySchema } from '../validators/attendanceLeaveSchemas.js';
import { reviewSchema } from '../validators/common.js';

const router = Router();
router.use(requireAuth);

router.get('/', requirePermission('attendance.view'), validate(registerQuerySchema, 'query'), attendanceController.register);
router.get('/monthly', requirePermission('attendance.view'), validate(monthQuerySchema, 'query'), attendanceController.monthly);
router.get('/flagged', requirePermission('attendance.review'), attendanceController.flagged);
router.patch('/:id/review', requirePermission('attendance.review'), validate(reviewSchema), attendanceController.review);

export default router;
