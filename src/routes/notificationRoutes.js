import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as notificationController from '../controllers/notificationController.js';

// Everyone sees only their own notifications
const router = Router();
router.use(requireAuth);

router.get('/', notificationController.list);
router.get('/count', notificationController.count);
router.post('/read-all', notificationController.markAllRead);
router.patch('/:id/read', notificationController.markRead);

export default router;
