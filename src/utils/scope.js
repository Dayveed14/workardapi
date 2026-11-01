// Builds the SQL condition that limits employee rows to a permission's scope.
// `alias` is the table alias used for employees in the query (usually "e").
//
// Example: scope "team" for a supervisor whose employee id is 7 →
//   (e.team_id IN (SELECT id FROM teams WHERE supervisor_employee_id = 7) OR e.id = 7)
export function scopeCondition(scope, me, alias = 'e') {
  if (scope === 'all') return { sql: '1=1', params: [] };

  // Every other scope is relative to the person's own employee record
  if (!me) return { sql: '1=0', params: [] };

  switch (scope) {
    case 'branch':
      return { sql: `${alias}.branch_id = ?`, params: [me.branchId ?? -1] };
    case 'department':
      return { sql: `${alias}.department_id = ?`, params: [me.departmentId ?? -1] };
    case 'team':
      return {
        sql: `(${alias}.team_id IN (SELECT id FROM teams WHERE supervisor_employee_id = ?) OR ${alias}.id = ?)`,
        params: [me.id, me.id],
      };
    case 'own':
      return { sql: `${alias}.id = ?`, params: [me.id] };
    default:
      return { sql: '1=0', params: [] };
  }
}

// Scope condition PLUS "people who report to me" (employees.manager_id).
// Used by tasks & reviews: a direct manager can always manage their own reports,
// even if their role has no scope for it.
export function managedCondition(scope, me, alias = 'e') {
  const byScope = scope ? scopeCondition(scope, me, alias) : { sql: '1=0', params: [] };
  if (!me) return byScope;
  return { sql: `(${byScope.sql} OR ${alias}.manager_id = ?)`, params: [...byScope.params, me.id] };
}
