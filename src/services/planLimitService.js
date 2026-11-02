import * as employeeModel from '../models/employeeModel.js';
import * as branchModel from '../models/branchModel.js';
import AppError from '../utils/AppError.js';

// Checks the organisation's plan limits before something is added.
// The limits come from config/plans.js (via req.auth.subscription).
const upgradeError = (message) =>
  new AppError(403, `${message} Upgrade in Settings → Plan & billing.`, undefined, 'PLAN_LIMIT');

export async function checkCanAddEmployee(auth) {
  const max = auth.subscription.limits.maxEmployees;
  if (max === null) return;
  const active = await employeeModel.countActive(auth.orgId, { sql: '1=1', params: [] });
  if (active >= max) throw upgradeError(`Your ${auth.subscription.planName} plan allows up to ${max} active employees.`);
}

export async function checkCanAddBranch(auth) {
  const max = auth.subscription.limits.maxBranches;
  if (max === null) return;
  const branches = await branchModel.listByOrg(auth.orgId);
  if (branches.length >= max) {
    throw upgradeError(`Your ${auth.subscription.planName} plan allows ${max === 1 ? 'one branch' : `up to ${max} branches`}.`);
  }
}

export function checkCanCreateRole(auth) {
  if (!auth.subscription.limits.customRoles) {
    throw upgradeError(`Custom roles are on the Enterprise plan. Your ${auth.subscription.planName} plan uses the built-in roles (you can still change their scopes).`);
  }
}
