import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as roleController from '../controllers/roleController.js';
import { roleSchema } from '../validators/organizationSchemas.js';

const router = Router();
router.use(requireAuth, requirePermission('roles.manage'));

router.get('/', roleController.list);
router.get('/permissions', roleController.catalog);
router.post('/', validate(roleSchema), roleController.create);
router.put('/:id', validate(roleSchema), roleController.update);
router.delete('/:id', roleController.remove);

export default router;
