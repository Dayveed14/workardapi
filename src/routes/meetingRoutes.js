import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as meetingController from '../controllers/meetingController.js';
import { meetingSchema, meetingUpdateSchema, rangeSchema, occurrenceSchema, skipSchema } from '../validators/meetingSchemas.js';

// Meetings are on every plan. Who can schedule / join: meetingService.
const router = Router();
router.use(requireAuth);

router.get('/', validate(rangeSchema, 'query'), meetingController.range);
router.get('/groups', meetingController.groups);
router.get('/people', meetingController.people);
router.post('/', validate(meetingSchema), meetingController.create);
router.get('/:id', meetingController.getOne);
router.patch('/:id', validate(meetingUpdateSchema), meetingController.update);
router.delete('/:id', meetingController.cancel);
router.post('/:id/skip', validate(skipSchema), meetingController.skip); //     cancel one date only
router.delete('/:id/skip', validate(skipSchema, 'query'), meetingController.unskip); // bring that date back
router.post('/:id/join', validate(occurrenceSchema, 'query'), meetingController.join);
router.get('/:id/standup', validate(occurrenceSchema, 'query'), meetingController.standup);

export default router;
