import { Router } from 'express';
import { requireAuth, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as onboardingController from '../controllers/onboardingController.js';
import { templateSchema, templateListSchema, startSchema, listSchema, itemDoneSchema, addItemSchema } from '../validators/onboardingSchemas.js';

// HR / owner manage everything (onboarding.manage); a new joiner can open and tick their own.
// Those rules are checked in onboardingService. Onboarding is part of HR, on every plan.
const router = Router();
router.use(requireAuth, requireFeature('hr'));

// Fixed paths first (before "/:id")
router.get('/templates', validate(templateListSchema, 'query'), onboardingController.listTemplates); // ?kind=offboarding
router.post('/templates', validate(templateSchema), onboardingController.createTemplate);
router.get('/templates/:id', onboardingController.getTemplate);
router.put('/templates/:id', validate(templateSchema), onboardingController.updateTemplate);
router.delete('/templates/:id', onboardingController.deleteTemplate);
router.get('/mine', onboardingController.mine);
router.get('/candidates', onboardingController.candidates);
router.patch('/items/:itemId', validate(itemDoneSchema), onboardingController.setItemDone);
router.delete('/items/:itemId', onboardingController.removeItem);

router.get('/', validate(listSchema, 'query'), onboardingController.list);
router.post('/', validate(startSchema), onboardingController.start);
router.get('/:id', onboardingController.getOne);
router.post('/:id/items', validate(addItemSchema), onboardingController.addItem);
router.post('/:id/cancel', onboardingController.cancel);

export default router;
