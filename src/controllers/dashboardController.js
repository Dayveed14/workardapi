import asyncHandler from '../utils/asyncHandler.js';
import * as dashboardService from '../services/dashboardService.js';

// GET /api/dashboard
export const getDashboard = asyncHandler(async (req, res) => {
  res.json(await dashboardService.getDashboard(req.auth, req.scope));
});
