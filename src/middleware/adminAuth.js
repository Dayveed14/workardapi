import { ADMIN_COOKIE, verifyAdminToken } from '../services/adminAuthService.js';
import * as adminModel from '../models/adminModel.js';
import AppError from '../utils/AppError.js';

// Workard super admins only. Checked against the database on every request,
// so removing or locking an admin takes effect immediately.
// req.admin = { userId, userName, email }
export async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.[ADMIN_COOKIE];
    if (!token) throw new AppError(401, 'Not logged in');
    let userId;
    try {
      userId = verifyAdminToken(token);
    } catch {
      throw new AppError(401, 'Session expired');
    }
    const admin = await adminModel.findByUserId(userId);
    if (!admin || admin.locked_at) throw new AppError(401, 'Not logged in');
    req.admin = { userId, userName: admin.full_name, email: admin.email };
    next();
  } catch (err) {
    next(err);
  }
}
