import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadMaterial } from '../middleware/upload.js';
import * as announcementController from '../controllers/announcementController.js';
import { postSchema, updatePostSchema, commentSchema, feedQuerySchema } from '../validators/announcementSchemas.js';

// Everyone can read the posts for their groups and comment.
// Posting needs announcements.post for that group (checked in announcementService).
// Part of every plan.
const router = Router();
router.use(requireAuth);

router.get('/', validate(feedQuerySchema, 'query'), announcementController.feed);
router.get('/groups', announcementController.groups);
router.get('/unseen', announcementController.unseen);
router.post('/', uploadMaterial, validate(postSchema), announcementController.create);
router.delete('/comments/:commentId', announcementController.removeComment);
router.patch('/:id', validate(updatePostSchema), announcementController.update);
router.delete('/:id', announcementController.remove);
router.post('/:id/comments', validate(commentSchema), announcementController.comment);
router.post('/:id/acknowledge', announcementController.acknowledge);
router.get('/:id/readers', announcementController.readers);

export default router;
