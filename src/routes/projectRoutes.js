import { Router } from 'express';
import { requireAuth, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as projectController from '../controllers/projectController.js';
import { projectSchema, projectUpdateSchema, projectListSchema } from '../validators/projectSchemas.js';

// Projects are part of Tasks (Business plan and up). Who can do what: projectService.
const router = Router();
router.use(requireAuth, requireFeature('tasks'));

router.get('/', validate(projectListSchema, 'query'), projectController.list);
router.get('/groups', projectController.groups);
router.post('/', validate(projectSchema), projectController.create);
router.get('/:id', projectController.getOne);
router.patch('/:id', validate(projectUpdateSchema), projectController.update);
router.delete('/:id', projectController.remove);

export default router;
