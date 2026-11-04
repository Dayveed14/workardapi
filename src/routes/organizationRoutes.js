import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as orgController from '../controllers/organizationController.js';
import {
  organizationSchema,
  branchSchema,
  nameSchema,
  teamSchema,
  leaveTypeSchema,
  holidaySchema,
  holidayYearSchema,
  nationalHolidaysSchema,
} from '../validators/organizationSchemas.js';

const router = Router();
router.use(requireAuth);

const manage = requirePermission('organization.manage');

// Any member (needed to fill dropdowns and show names)
router.get('/', orgController.getOrganization);
router.get('/structure', orgController.structure);
router.get('/my-ip', orgController.myIp);

router.patch('/', manage, validate(organizationSchema), orgController.updateOrganization);

router.post('/branches', manage, validate(branchSchema), orgController.createBranch);
router.put('/branches/:id', manage, validate(branchSchema), orgController.updateBranch);
router.delete('/branches/:id', manage, orgController.deleteBranch);

router.post('/departments', manage, validate(nameSchema), orgController.createDepartment);
router.put('/departments/:id', manage, validate(nameSchema), orgController.updateDepartment);
router.delete('/departments/:id', manage, orgController.deleteDepartment);

router.post('/teams', manage, validate(teamSchema), orgController.createTeam);
router.put('/teams/:id', manage, validate(teamSchema), orgController.updateTeam);
router.delete('/teams/:id', manage, orgController.deleteTeam);

// Public holidays — everyone can see them; only managers of the organisation change them
router.get('/holidays', validate(holidayYearSchema, 'query'), orgController.holidays);
router.post('/holidays', manage, validate(holidaySchema), orgController.addHoliday);
router.post('/holidays/national', manage, validate(nationalHolidaysSchema), orgController.addNationalHolidays);
router.delete('/holidays/:id', manage, orgController.removeHoliday);

router.post('/leave-types', manage, validate(leaveTypeSchema), orgController.createLeaveType);
router.put('/leave-types/:id', manage, validate(leaveTypeSchema), orgController.updateLeaveType);

router.get('/audit-logs', requirePermission('audit.view'), orgController.auditLogs);

export default router;
