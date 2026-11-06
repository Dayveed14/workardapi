// ============================================================
// AUDIENCES — who an announcement, a team material or a meeting is for.
//   { type: 'company' }                      everyone
//   { type: 'branch',     id: 3 }            everyone in branch 3
//   { type: 'department', id: 5 }            everyone in department 5
//   { type: 'team',       id: 9 }            team 9 (and its supervisor)
//
// Who may post / share / schedule for an audience depends on the scope of the
// permission (e.g. announcements.post):
//   all        → any audience, including the whole company
//   branch     → their own branch
//   department → their own department, or any team in it
//   team       → the teams they supervise
// ============================================================
import AppError from './AppError.js';

export const AUDIENCE_TYPES = ['company', 'branch', 'department', 'team'];

// team = the teams row (needed to check department / supervisor) when type is 'team'
export function canTarget(scope, me, audience, team = null) {
  if (scope === 'all') return true;
  if (!me || !scope) return false;
  const id = Number(audience.id);
  switch (audience.type) {
    case 'branch':
      return scope === 'branch' && id === me.branchId;
    case 'department':
      return scope === 'department' && id === me.departmentId;
    case 'team':
      if (!team) return false;
      if (scope === 'department') return team.department_id === me.departmentId;
      if (scope === 'branch') return false;
      return scope === 'team' && team.supervisor_employee_id === me.id;
    default:
      return false; // the whole company needs "all"
  }
}

export function requireTarget(scope, me, audience, team, what = 'post to') {
  if (!canTarget(scope, me, audience, team)) {
    throw new AppError(403, `You can’t ${what} that group`, { audience: 'Choose a group you manage' });
  }
}

// SQL: rows (alias `a`, with audience_type / audience_id columns) that this person belongs to
export function memberOfCondition(me, alias = 'a') {
  if (!me) return { sql: `${alias}.audience_type = 'company'`, params: [] };
  return {
    sql: `(${alias}.audience_type = 'company'
       OR (${alias}.audience_type = 'branch' AND ${alias}.audience_id = ?)
       OR (${alias}.audience_type = 'department' AND ${alias}.audience_id = ?)
       OR (${alias}.audience_type = 'team' AND (${alias}.audience_id = ?
            OR ${alias}.audience_id IN (SELECT id FROM teams WHERE supervisor_employee_id = ?))))`,
    params: [me.branchId ?? -1, me.departmentId ?? -1, me.teamId ?? -1, me.id],
  };
}
