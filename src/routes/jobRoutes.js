import { Router } from 'express';
import * as jobController from '../controllers/jobController.js';

// No login — protected by the CRON_SECRET header instead
const router = Router();
router.post('/daily', jobController.daily);

export default router;
