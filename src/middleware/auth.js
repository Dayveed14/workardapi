import { ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../services/tokenService.js';
import { findContext } from '../models/membershipModel.js';
import { findSuspension } from '../models/platformModel.js';
import { contextFor as supportContext } from '../services/supportService.js';
import AppError from '../utils/AppError.js';

// Checks the JWT, then loads who this person is in the current organisation:
// their role, permissions and employee record. Result is put on req.auth:
//
// req.auth = {
//   subscription: { plan, status, usable, features, limits, ... }  (see utils/subscription.js)
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

    // A Workard support visit (the owner allowed it): read-only, no plan checks
    if (payload.sup) {
      const visit = await supportContext(payload);
      if (!visit) throw new AppError(401, 'The support access has ended');
      req.auth = visit;
      const canWrite = ['/api/auth/logout'].some((p) => req.originalUrl.startsWith(p));
      if (req.method !== 'GET' && !canWrite) throw new AppError(403, 'Workard support access is read-only');
      return next();
    }

    const context = await findContext(Number(payload.sub), Number(payload.oid));
    if (!context) throw new AppError(401, 'Your access to this organisation has ended');
    if (context.locked) throw new AppError(401, 'This account is locked. Write to hello@workard.com.');

    req.auth = context;

    // Suspended by Workard: nothing works except logging out
    const suspension = await findSuspension(context.orgId);
    if (suspension && !req.originalUrl.startsWith('/api/auth/logout')) {
      return res.status(423).json({
        code: 'ORGANIZATION_SUSPENDED',
        message: `This company’s Workard account is suspended: ${suspension.suspended_reason}. Write to hello@workard.com to sort it out.`,
        reason: suspension.suspended_reason,
      });
    }

    // Unpaid or expired plan: only sign-in and billing work until the owner pays
    const allowed = ['/api/auth/', '/api/billing'].some((p) => req.originalUrl.startsWith(p));
    if (!context.subscription.usable && !allowed) {
      return res.status(402).json({
        code: 'SUBSCRIPTION_REQUIRED',
        message:
          context.subscription.status === 'trial_ended'
            ? 'Your free trial has ended. The owner needs to choose a plan and pay to keep using Workard.'
            : 'Your Workard plan has expired. The owner needs to renew it.',
      });
    }
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

// Usage: router.use(requireAuth, requireFeature('payroll'))
// Blocks parts of the app that the organisation's plan doesn't include.
export function requireFeature(feature) {
  return (req, res, next) => {
    if (req.auth?.subscription?.features.includes(feature)) return next();
    return res.status(403).json({
      code: 'PLAN_UPGRADE_REQUIRED',
      feature,
      message: 'Your plan does not include this. Upgrade in Settings → Plan & billing.',
    });
  };
}
