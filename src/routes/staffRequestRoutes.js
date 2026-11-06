import { Router } from 'express';
import { requireAuth, requireFeature, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as staffRequestController from '../controllers/staffRequestController.js';
import {
  staffRequestSchema,
  decisionSchema,
  requestListSchema,
  feedbackSchema,
  feedbackReplySchema,
  feedbackListSchema,
} from '../validators/requestSchemas.js';

// Staff requests. Who can approve / pay out is checked in staffRequestService.
// Advances & loans are repaid through payroll, so they need the payroll feature.
// Feedback is on every plan.
const router = Router();
router.use(requireAuth);

// ---------- Feedback (fixed paths first) ----------
router.post('/feedback', validate(feedbackSchema), staffRequestController.sendFeedback);
router.get('/feedback/mine', staffRequestController.myFeedback);
router.get('/feedback/inbox', requirePermission('feedback.manage'), validate(feedbackListSchema, 'query'), staffRequestController.feedbackInbox);
router.get('/feedback/private/:token', staffRequestController.feedbackByToken);
router.post('/feedback/private/:token/replies', validate(feedbackReplySchema), staffRequestController.replyByToken);
router.get('/feedback/:id', staffRequestController.getFeedback);
router.post('/feedback/:id/replies', validate(feedbackReplySchema), staffRequestController.replyFeedback);

// ---------- Salary advances & loans ----------
const payroll = requireFeature('payroll');
router.get('/', payroll, validate(requestListSchema, 'query'), staffRequestController.list);
router.get('/limits', payroll, staffRequestController.limits);
router.post('/', payroll, validate(staffRequestSchema), staffRequestController.create);
router.get('/:id', payroll, staffRequestController.getOne);
router.patch('/:id/decision', payroll, validate(decisionSchema), staffRequestController.decide);
router.post('/:id/paid-out', payroll, staffRequestController.paidOut);
router.post('/:id/cancel', payroll, staffRequestController.cancel);

export default router;
