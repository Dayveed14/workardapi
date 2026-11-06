import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as billingController from '../controllers/billingController.js';
import { checkoutSchema, verifySchema, autoRenewSchema } from '../validators/billingSchemas.js';

// These keep working even when the plan is unpaid or expired (see middleware/auth.js),
// so the owner can always pay. Only the Owner can pay (checked in billingService).
const router = Router();

router.get('/plans', billingController.plans); // public: the sign-up page shows the plans
router.get('/config', billingController.config); // public: is billing on? trial length

router.use(requireAuth);
router.get('/', billingController.overview);
router.post('/checkout', validate(checkoutSchema), billingController.checkout);
router.post('/verify', validate(verifySchema), billingController.verify);
router.post('/change', validate(checkoutSchema), billingController.scheduleChange);
router.delete('/change', billingController.cancelChange);
router.post('/auto-renew', validate(autoRenewSchema), billingController.autoRenew);
router.get('/card-link', billingController.cardLink);

export default router;
