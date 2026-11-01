import asyncHandler from '../utils/asyncHandler.js';
import * as employeeService from '../services/employeeService.js';
import * as roleService from '../services/roleService.js';
import * as attendanceService from '../services/attendanceService.js';
import * as leaveService from '../services/leaveService.js';

// GET /api/employees?search=&branchId=&departmentId=&status=&page=
export const list = asyncHandler(async (req, res) => {
  res.json(await employeeService.listEmployees(req.auth, req.scope, req.validatedQuery));
});

// GET /api/employees/:id
export const getOne = asyncHandler(async (req, res) => {
  res.json(await employeeService.getEmployee(req.auth, req.params.id));
});

// POST /api/employees
export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await employeeService.createEmployee(req.auth, req.body));
});

// PATCH /api/employees/:id
export const update = asyncHandler(async (req, res) => {
  res.json(await employeeService.updateEmployee(req.auth, req.params.id, req.body));
});

// POST /api/employees/:id/exit
export const exit = asyncHandler(async (req, res) => {
  res.json(await employeeService.exitEmployee(req.auth, req.params.id, req.body));
});

// POST /api/employees/:id/photo (multipart, field "file")
export const uploadPhoto = asyncHandler(async (req, res) => {
  res.json(await employeeService.uploadPhoto(req.auth, req.params.id, req.file));
});

// PATCH /api/employees/:id/role
export const assignRole = asyncHandler(async (req, res) => {
  res.json(await roleService.assignRole(req.auth, req.params.id, req.body.roleId));
});

// GET /api/employees/:id/attendance?month=2026-11
export const attendance = asyncHandler(async (req, res) => {
  res.json(await attendanceService.employeeHistory(req.auth, req.params.id, req.validatedQuery.month));
});

// GET /api/employees/:id/leave
export const leave = asyncHandler(async (req, res) => {
  res.json(await leaveService.employeeLeave(req.auth, req.params.id));
});
