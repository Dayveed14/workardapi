import { Router } from 'express';
import { requireAuth, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as c from '../controllers/offboardingController.js';
import * as s from '../validators/offboardingSchemas.js';

// Offboarding (someone leaving). HR / owner run it (onboarding.manage); the leaver sees
// and ticks their own items; anyone can resign. Checked in offboardingService. Part of HR.
const router = Router();
router.use(requireAuth, requireFeature('hr'));

// Fixed paths first (before "/:id")
router.get('/settings', c.settings);
router.put('/settings', validate(s.noticeSchema), c.setNotice);
router.get('/mine', c.mine);
router.post('/resign', validate(s.resignSchema), c.resign);
router.patch('/items/:itemId', validate(s.itemDoneSchema), c.setItemDone);
router.delete('/items/:itemId', c.removeItem);

router.get('/', validate(s.listSchema, 'query'), c.list);
router.post('/', validate(s.startSchema), c.start);
router.get('/:id', c.getOne);
router.post('/:id/checklist', validate(s.checklistSchema), c.sendChecklist);
router.post('/:id/items', validate(s.addItemSchema), c.addItem);
router.patch('/:id/last-day', validate(s.lastDaySchema), c.setLastDay);
router.post('/:id/exit-now', c.exitNow);
router.post('/:id/withdraw', c.withdraw);
router.post('/:id/cancel', c.cancel);

export default router;
