import * as projectModel from '../models/projectModel.js';
import * as taskModel from '../models/taskModel.js';
import * as audienceModel from '../models/audienceModel.js';
import * as auditModel from '../models/auditModel.js';
import { checkAudience, groupsFor } from './audienceService.js';
import { memberOfCondition, canTarget } from '../utils/audience.js';
import AppError from '../utils/AppError.js';

// ============================================================
// PROJECTS — a set of tasks for a group (team / department / branch / company),
// with progress and a board everyone in the group can follow.
//   See it:     people in its group, anyone with a task in it, projects.manage "all"
//   Change it:  anyone whose projects.manage scope covers its group
//   Add tasks:  anyone who can see it (who they can assign to follows the task rules)
// ============================================================

const audienceOf = (p) => ({ type: p.audience_type, id: p.audience_id });

function visibleCondition(auth) {
  if (auth.permissions['projects.manage'] === 'all') return { sql: '1=1', params: [] };
  const member = memberOfCondition(auth.employee, 'p');
  return {
    sql: `(${member.sql} OR p.created_by = ?
       OR EXISTS (SELECT 1 FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE t.project_id = p.id AND ta.employee_id = ?))`,
    params: [...member.params, auth.userId, auth.employee?.id ?? -1],
  };
}

async function canManage(auth, project) {
  const audience = audienceOf(project);
  const team = audience.type === 'team' ? await audienceModel.findTeam(auth.orgId, audience.id) : null;
  return canTarget(auth.permissions['projects.manage'], auth.employee, audience, team);
}

// Used by taskService: may this person use / see this project?
export async function requireProject(auth, projectId) {
  const cond = visibleCondition(auth);
  const [project] = await projectModel.listVisible(auth.orgId, { sql: `p.id = ? AND ${cond.sql}`, params: [Number(projectId), ...cond.params] }, {});
  if (!project) throw new AppError(404, 'Project not found', { projectId: 'Choose a project you can see' });
  return project;
}

export async function list(auth, { status }) {
  const rows = await projectModel.listVisible(auth.orgId, visibleCondition(auth), { status });
  const result = [];
  for (const p of rows) result.push({ ...p, canManage: await canManage(auth, p) });
  return result;
}

export const projectGroups = (auth) => groupsFor(auth, 'projects.manage');

// The project, its tasks (with everyone on them), and the people in it with their own progress
export async function getProject(auth, id) {
  const project = await requireProject(auth, id);
  const { rows: tasks } = await taskModel.list(auth.orgId, { sql: '1=1', params: [] }, { projectId: project.id, limit: 500, offset: 0 });

  // People: everyone in the group + anyone on a task in it
  const people = new Map();
  for (const m of await audienceModel.members(auth.orgId, audienceOf(project))) {
    people.set(m.id, { id: m.id, first_name: m.first_name, last_name: m.last_name, photo_url: m.photo_url, todo: 0, in_progress: 0, done: 0, overdue: 0 });
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const t of tasks.filter((x) => x.status !== 'cancelled')) {
    for (const a of t.assignees) {
      if (!people.has(a.id)) people.set(a.id, { id: a.id, first_name: a.first_name, last_name: a.last_name, photo_url: a.photo_url, todo: 0, in_progress: 0, done: 0, overdue: 0 });
      const p = people.get(a.id);
      p[t.status] += 1;
      if (t.status !== 'done' && t.due_date && t.due_date < today) p.overdue += 1;
    }
  }
  return {
    ...project,
    canManage: await canManage(auth, project),
    tasks,
    people: [...people.values()].sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`)),
  };
}

export async function createProject(auth, data) {
  const audience = { type: data.audienceType, id: data.audienceType === 'company' ? null : data.audienceId };
  await checkAudience(auth, 'projects.manage', audience, 'create projects for');
  const id = await projectModel.create(auth.orgId, { ...data, audienceType: audience.type, audienceId: audience.id, createdBy: auth.userId });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'project.created', details: data.name });
  return getProject(auth, id);
}

export async function updateProject(auth, id, data) {
  const project = await requireProject(auth, id);
  if (!(await canManage(auth, project))) throw new AppError(403, 'Only managers of this group can change the project');
  await projectModel.update(auth.orgId, id, data);
  return getProject(auth, id);
}

export async function deleteProject(auth, id) {
  const project = await requireProject(auth, id);
  if (!(await canManage(auth, project))) throw new AppError(403, 'Only managers of this group can delete the project');
  await projectModel.remove(auth.orgId, id);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'project.deleted', details: project.name });
}
