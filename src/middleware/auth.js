import { ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../services/tokenService.js';
import { findContext } from '../models/membershipModel.js';
import AppError from '../utils/AppError.js';

// Checks the JWT, then loads who this person is in the current organisation:
// their role, permissions and employee record. Result is put on req.auth:
//
// req.auth = {
//   userId, userName, orgId, role: { id, name, isOwner },
//   permissions: { 'employees.view': 'team', ... },
//   employee: { id, branchId, departmentId, teamId } | null
// }
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    const token = req.cookies?.[ACCESS_COOKIE] || (header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) throw new AppError(401, 'Not authenticated');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw new AppError(401, 'Session expired');
    }

    const context = await findContext(Number(payload.sub), Number(payload.oid));
    if (!context) throw new AppError(401, 'Your access to this organisation has ended');

    req.auth = context;
    next();
  } catch (err) {
    next(err);
  }
}

// Usage: router.get('/', requirePermission('employees.view'), controller)
// Puts the scope ("own" | "team" | "department" | "branch" | "all") on req.scope
export function requirePermission(key) {
  return (req, res, next) => {
    const scope = req.auth?.permissions?.[key];
    if (!scope) return next(new AppError(403, 'You do not have permission to do this'));
    req.scope = scope;
    next();
  };
}

// Allows the request if the person has ANY of these permissions.
// Usage: requireAnyPermission('invoices.manage', 'customers.view')
export function requireAnyPermission(...keys) {
  return (req, res, next) => {
    const allowed = keys.some((k) => req.auth?.permissions?.[k]);
    if (!allowed) return next(new AppError(403, 'You do not have permission to do this'));
    next();
  };
}
