import * as employeeModel from '../models/employeeModel.js';
import * as customerModel from '../models/customerModel.js';
import { scopeCondition } from '../utils/scope.js';
import AppError from '../utils/AppError.js';

// Returns the employee if the logged-in person may access them with this permission.
// People can always VIEW their own record (allowSelf = true).
export async function getEmployeeOrFail(auth, permissionKey, employeeId, { allowSelf = false } = {}) {
  const isSelf = auth.employee && Number(auth.employee.id) === Number(employeeId);
  const scope = auth.permissions[permissionKey];

  if (isSelf && allowSelf) {
    const employee = await employeeModel.findById(auth.orgId, employeeId);
    if (employee) return employee;
  }

  if (!scope) throw new AppError(403, 'You do not have permission to do this');

  const employee = await employeeModel.findInScope(auth.orgId, employeeId, scopeCondition(scope, auth.employee));
  if (!employee) throw new AppError(404, 'Employee not found');
  return employee;
}

// Returns the customer if the person may access it with this permission.
// Customer scope is based on who the account is ASSIGNED to
// ("own" = accounts assigned to me, "team" = assigned to my team, ...).
export async function getCustomerOrFail(auth, permissionKey, customerId) {
  const scope = auth.permissions[permissionKey];
  if (!scope) throw new AppError(403, 'You do not have permission to do this');

  const customer = await customerModel.findInScope(auth.orgId, customerId, scopeCondition(scope, auth.employee));
  if (!customer) throw new AppError(404, 'Customer not found');
  return customer;
}
