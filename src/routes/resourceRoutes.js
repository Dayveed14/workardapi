import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadMaterial } from '../middleware/upload.js';
import * as resourceController from '../controllers/resourceController.js';
import { resourceSchema, resourceUpdateSchema, sendSchema, resourceListSchema } from '../validators/resourceSchemas.js';

// Everyone reads the materials for their groups.
// Creating / editing / sending needs resources.manage for that group (checked in resourceService).
const router = Router();
router.use(requireAuth);

router.get('/', validate(resourceListSchema, 'query'), resourceController.list);
router.get('/groups', resourceController.groups);
router.post('/', uploadMaterial, validate(resourceSchema), resourceController.create);
router.get('/:id', resourceController.getOne);
router.patch('/:id', validate(resourceUpdateSchema), resourceController.update);
router.post('/:id/file', uploadMaterial, resourceController.replaceFile);
router.get('/:id/versions/:version', resourceController.version);
router.post('/:id/send', validate(sendSchema), resourceController.send);
router.delete('/:id', resourceController.remove);

export default router;
