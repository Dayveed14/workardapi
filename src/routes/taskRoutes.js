import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadDocument } from '../middleware/upload.js';
import * as taskController from '../controllers/taskController.js';
import {
  createTaskSchema,
  updateTaskSchema,
  statusSchema,
  listTasksSchema,
  checklistItemSchema,
  checklistToggleSchema,
  commentSchema,
  recurringTaskSchema,
} from '../validators/taskSchemas.js';

// Everyone can use tasks for themselves, so there is no blanket permission here.
// Who may see / change each task is checked in taskService (assignee, creator, scope, manager).
const router = Router();
router.use(requireAuth);

// Fixed paths first (before "/:id")
router.get('/', validate(listTasksSchema, 'query'), taskController.list);
router.get('/counts', taskController.counts);
router.get('/assignees', taskController.assignees);
router.get('/recurring', taskController.listRecurring);
router.post('/recurring', validate(recurringTaskSchema), taskController.createRecurring);
router.put('/recurring/:id', validate(recurringTaskSchema), taskController.updateRecurring);
router.delete('/recurring/:id', taskController.removeRecurring);
router.patch('/checklist/:itemId', validate(checklistToggleSchema), taskController.toggleChecklistItem);
router.delete('/checklist/:itemId', taskController.removeChecklistItem);
router.delete('/attachments/:attachmentId', taskController.removeAttachment);

router.post('/', validate(createTaskSchema), taskController.create);
router.get('/:id', taskController.getOne);
router.patch('/:id', validate(updateTaskSchema), taskController.update);
router.patch('/:id/status', validate(statusSchema), taskController.setStatus);
router.delete('/:id', taskController.remove);
router.post('/:id/checklist', validate(checklistItemSchema), taskController.addChecklistItem);
router.post('/:id/comments', validate(commentSchema), taskController.addComment);
router.post('/:id/attachments', uploadDocument, taskController.addAttachment);

export default router;
