import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import * as dashboardController from '../controllers/dashboardController.js';

const router = Router();

router.get('/', requireAuth, requirePermission('dashboard.view'), dashboardController.getDashboard);

export default router;
