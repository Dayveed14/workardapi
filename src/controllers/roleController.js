import asyncHandler from '../utils/asyncHandler.js';
import * as roleService from '../services/roleService.js';

// GET /api/roles
export const list = asyncHandler(async (req, res) => {
  res.json(await roleService.listRoles(req.auth.orgId));
});

// GET /api/roles/permissions → the list of all permissions (for the role editor)
export const catalog = (req, res) => {
  res.json(roleService.getCatalog());
};

export const create = asyncHandler(async (req, res) => {
  res.status(201).json(await roleService.createRole(req.auth, req.body));
});

export const update = asyncHandler(async (req, res) => {
  res.json(await roleService.updateRole(req.auth, req.params.id, req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await roleService.deleteRole(req.auth, req.params.id);
  res.json({ message: 'Role deleted' });
});
