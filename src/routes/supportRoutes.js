import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as c from '../controllers/siteController.js';
import { supportGrantSchema } from '../validators/adminSchemas.js';

// /api/support-access — the OWNER lets Workard support look around (read-only, for a few hours)
const router = Router();
router.use(requireAuth);
router.get('/', c.supportStatus);
router.post('/', validate(supportGrantSchema), c.supportGrant);
router.delete('/', c.supportRevoke);
export default router;
