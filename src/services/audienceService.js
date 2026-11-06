import * as audienceModel from '../models/audienceModel.js';
import { canTarget, requireTarget } from '../utils/audience.js';
import AppError from '../utils/AppError.js';

// The groups this person may post / share / schedule for, with a permission like announcements.post
export async function groupsFor(auth, permissionKey) {
  const scope = auth.permissions[permissionKey];
  const me = auth.employee;
  const { branches, departments, teams } = await audienceModel.listGroups(auth.orgId);
  const groups = [];
  if (canTarget(scope, me, { type: 'company' })) groups.push({ type: 'company', id: null, label: 'Everyone' });
  for (const b of branches) if (canTarget(scope, me, { type: 'branch', id: b.id })) groups.push({ type: 'branch', id: b.id, label: `${b.name} branch` });
  for (const d of departments) if (canTarget(scope, me, { type: 'department', id: d.id })) groups.push({ type: 'department', id: d.id, label: `${d.name} department` });
  for (const t of teams) if (canTarget(scope, me, { type: 'team', id: t.id }, t)) groups.push({ type: 'team', id: t.id, label: `${t.name} team` });
  return groups;
}

// Throws unless the group exists and this person may use it
export async function checkAudience(auth, permissionKey, audience, what) {
  if (audience.type !== 'company' && !(await audienceModel.exists(auth.orgId, audience))) {
    throw new AppError(422, 'That group no longer exists', { audience: 'Choose a group' });
  }
  const team = audience.type === 'team' ? await audienceModel.findTeam(auth.orgId, audience.id) : null;
  requireTarget(auth.permissions[permissionKey], auth.employee, audience, team, what);
}
