import { Router } from 'express';
import { requireAuth, requirePermission, requireFeature } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadDocument, uploadImage } from '../middleware/upload.js';
import * as employeeController from '../controllers/employeeController.js';
import * as documentController from '../controllers/documentController.js';
import * as inviteController from '../controllers/inviteController.js';
import * as payrollController from '../controllers/payrollController.js';
import { employeePaySchema } from '../validators/payrollSchemas.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listEmployeesSchema,
  exitEmployeeSchema,
  inviteSchema,
  assignRoleSchema,
  documentSchema,
} from '../validators/employeeSchemas.js';
import { monthQuerySchema } from '../validators/attendanceLeaveSchemas.js';

const router = Router();
router.use(requireAuth);

router.get('/', requirePermission('employees.view'), validate(listEmployeesSchema, 'query'), employeeController.list);
router.post('/', requirePermission('employees.create'), validate(createEmployeeSchema), employeeController.create);

// For these, the service decides: your own record is always allowed, others need the permission + scope
router.get('/:id', employeeController.getOne);
router.patch('/:id', requirePermission('employees.edit'), validate(updateEmployeeSchema), employeeController.update);
router.post('/:id/exit', requirePermission('employees.exit'), validate(exitEmployeeSchema), employeeController.exit);
router.post('/:id/photo', uploadImage, employeeController.uploadPhoto);
router.get('/:id/attendance', validate(monthQuerySchema, 'query'), employeeController.attendance);
router.get('/:id/leave', employeeController.leave);

// Login access
router.post('/:id/invite', requirePermission('employees.create'), validate(inviteSchema), inviteController.sendInvite);
router.patch('/:id/role', requirePermission('roles.manage'), validate(assignRoleSchema), employeeController.assignRole);

// Pay (Phase 3) — salary, bank & pension details
router.get('/:id/pay', requireFeature('payroll'), requirePermission('payroll.view'), payrollController.getEmployeePay);
router.put('/:id/pay', requireFeature('payroll'), requirePermission('payroll.manage'), validate(employeePaySchema), payrollController.saveEmployeePay);

// Documents
router.get('/:id/documents', documentController.list);
router.post('/:id/documents', uploadDocument, validate(documentSchema), documentController.upload);

export default router;
