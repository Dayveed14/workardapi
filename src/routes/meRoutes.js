import { Router } from 'express';
import { requireAuth, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as attendanceController from '../controllers/attendanceController.js';
import * as leaveController from '../controllers/leaveController.js';
import * as payrollController from '../controllers/payrollController.js';
import { clockInSchema, monthQuerySchema, leaveRequestSchema, explanationSchema } from '../validators/attendanceLeaveSchemas.js';

// Self-service: things every employee can do for themselves (no permission needed)
const router = Router();
router.use(requireAuth);

router.get('/attendance/today', attendanceController.today);
router.post('/attendance/clock-in', validate(clockInSchema), attendanceController.clockIn);
router.post('/attendance/clock-out', attendanceController.clockOut);
router.get('/attendance', validate(monthQuerySchema, 'query'), attendanceController.myHistory);
router.post('/attendance/:id/explanation', validate(explanationSchema), attendanceController.explain);

router.get('/leave', leaveController.myLeave);
router.post('/leave', validate(leaveRequestSchema), leaveController.request);
router.post('/leave/:id/cancel', leaveController.cancel);

router.get('/payslips', requireFeature('payroll'), payrollController.myPayslips);

export default router;
