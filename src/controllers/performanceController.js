import asyncHandler from '../utils/asyncHandler.js';
import * as performanceService from '../services/performanceService.js';

// GET /api/performance?month=&months=&departmentId=  (everyone the viewer may see reviews for)
export const getPerformance = asyncHandler(async (req, res) => {
  res.json(await performanceService.getPerformance(req.auth, req.scope, req.validatedQuery));
});
