import asyncHandler from '../utils/asyncHandler.js';
import * as organizationService from '../services/organizationService.js';
import { getClientIp } from '../utils/ip.js';

export const getOrganization = asyncHandler(async (req, res) => {
  res.json(await organizationService.getOrganization(req.auth.orgId));
});

export const updateOrganization = asyncHandler(async (req, res) => {
  res.json(await organizationService.updateOrganization(req.auth, req.body));
});

// GET /api/organization/structure → branches, departments, teams, leave types, employees, roles (for dropdowns)
export const structure = asyncHandler(async (req, res) => {
  res.json(await organizationService.getStructure(req.auth.orgId));
});

// GET /api/organization/my-ip → helps an admin fill in the office IP while sitting in the office
export const myIp = (req, res) => {
  res.json({ ip: getClientIp(req) });
};

export const createBranch = asyncHandler(async (req, res) => {
  res.status(201).json(await organizationService.createBranch(req.auth, req.body));
});
export const updateBranch = asyncHandler(async (req, res) => {
  res.json(await organizationService.updateBranch(req.auth, req.params.id, req.body));
});
export const deleteBranch = asyncHandler(async (req, res) => {
  await organizationService.deleteBranch(req.auth, req.params.id);
  res.json({ message: 'Branch deleted' });
});

export const createDepartment = asyncHandler(async (req, res) => {
  res.status(201).json(await organizationService.createDepartment(req.auth, req.body));
});
export const updateDepartment = asyncHandler(async (req, res) => {
  res.json(await organizationService.updateDepartment(req.auth, req.params.id, req.body));
});
export const deleteDepartment = asyncHandler(async (req, res) => {
  await organizationService.deleteDepartment(req.auth, req.params.id);
  res.json({ message: 'Department deleted' });
});

export const createTeam = asyncHandler(async (req, res) => {
  res.status(201).json(await organizationService.createTeam(req.auth, req.body));
});
export const updateTeam = asyncHandler(async (req, res) => {
  res.json(await organizationService.updateTeam(req.auth, req.params.id, req.body));
});
export const deleteTeam = asyncHandler(async (req, res) => {
  await organizationService.deleteTeam(req.auth, req.params.id);
  res.json({ message: 'Team deleted' });
});

export const createLeaveType = asyncHandler(async (req, res) => {
  res.status(201).json(await organizationService.createLeaveType(req.auth, req.body));
});
export const updateLeaveType = asyncHandler(async (req, res) => {
  res.json(await organizationService.updateLeaveType(req.auth, req.params.id, req.body));
});

// GET /api/organization/audit-logs?page=
export const auditLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  res.json(await organizationService.listAuditLogs(req.auth.orgId, { limit: 50, offset: (page - 1) * 50 }));
});

// ---------- Public holidays ----------
// GET /api/organization/holidays?year=2026
export const holidays = asyncHandler(async (req, res) => {
  res.json(await organizationService.listHolidays(req.auth.orgId, req.validatedQuery.year));
});
// POST /api/organization/holidays  { date, name }
export const addHoliday = asyncHandler(async (req, res) => {
  res.status(201).json(await organizationService.addHoliday(req.auth, req.body));
});
// POST /api/organization/holidays/national  { year }  (Nigeria's fixed-date holidays)
export const addNationalHolidays = asyncHandler(async (req, res) => {
  res.status(201).json(await organizationService.addNationalHolidays(req.auth, req.body.year));
});
// DELETE /api/organization/holidays/:id
export const removeHoliday = asyncHandler(async (req, res) => {
  await organizationService.removeHoliday(req.auth, req.params.id);
  res.json({ message: 'Holiday removed' });
});
