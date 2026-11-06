import * as resourceModel from '../models/resourceModel.js';
import * as audienceModel from '../models/audienceModel.js';
import * as auditModel from '../models/auditModel.js';
import { checkAudience, groupsFor } from './audienceService.js';
import { notify, emailEach } from './notificationService.js';
import { storeFile, deleteFile } from './uploadService.js';
import { resourceEmail } from './emailService.js';
import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { memberOfCondition, canTarget } from '../utils/audience.js';
import { cleanHtml, htmlToText } from '../utils/cleanHtml.js';
import AppError from '../utils/AppError.js';

// ============================================================
// TEAM RESOURCES
//   documents → written & edited inside Workard (SOPs, scripts) — old versions kept
//   files     → uploaded (PDF, Word, Excel, slides, images) — can't be edited here;
//               "Upload new version" replaces it and keeps the old one in the history
// Who sees one:   people in its group (and anyone with resources.manage "all")
// Who changes it: anyone allowed to share with its group (resources.manage scope)
// "Send to team": bell (and optional email) for everyone in the group
// ============================================================

const audienceOf = (r) => ({ type: r.audience_type, id: r.audience_id });

function visibleCondition(auth) {
  if (auth.permissions['resources.manage'] === 'all') return { sql: '1=1', params: [] };
  const member = memberOfCondition(auth.employee, 'r');
  return { sql: `(${member.sql} OR r.created_by = ?)`, params: [...member.params, auth.userId] };
}

async function canManage(auth, resource) {
  const audience = audienceOf(resource);
  const team = audience.type === 'team' ? await audienceModel.findTeam(auth.orgId, audience.id) : null;
  return canTarget(auth.permissions['resources.manage'], auth.employee, audience, team);
}

async function getVisibleOrFail(auth, id) {
  const cond = visibleCondition(auth);
  const [row] = await resourceModel.listVisible(auth.orgId, { sql: `r.id = ? AND ${cond.sql}`, params: [Number(id), ...cond.params] }, {});
  if (!row) throw new AppError(404, 'Resource not found');
  return resourceModel.findById(auth.orgId, id);
}

async function getManageableOrFail(auth, id) {
  const resource = await getVisibleOrFail(auth, id);
  if (!(await canManage(auth, resource))) throw new AppError(403, 'Only managers of this group can change it');
  return resource;
}

export async function list(auth, { search }) {
  const rows = await resourceModel.listVisible(auth.orgId, visibleCondition(auth), { search });
  const result = [];
  for (const r of rows) result.push({ ...r, canManage: await canManage(auth, r) });
  return result;
}

export const sharingGroups = (auth) => groupsFor(auth, 'resources.manage');

export async function getOne(auth, id) {
  const resource = await getVisibleOrFail(auth, id);
  return { ...resource, canManage: await canManage(auth, resource), versions: await resourceModel.versions(resource.id) };
}

// A new document (written here) or file (uploaded)
export async function create(auth, data, file) {
  const audience = { type: data.audienceType, id: data.audienceType === 'company' ? null : data.audienceId };
  await checkAudience(auth, 'resources.manage', audience, 'share with');

  let fields;
  if (data.kind === 'document') {
    const body = cleanHtml(data.body);
    if (!htmlToText(body)) throw new AppError(422, 'Write something first', { body: 'Write the document' });
    fields = { body };
  } else {
    if (!file) throw new AppError(422, 'Choose a file to upload', { file: 'Choose a file' });
    const stored = await storeFile(file, { orgId: auth.orgId, subfolder: 'resources', devMaxKb: 2048 });
    fields = { fileUrl: stored.url, fileName: file.originalname, fileType: file.mimetype, fileSize: file.size, filePublicId: stored.publicId };
  }

  const id = await resourceModel.create(auth.orgId, {
    audienceType: audience.type,
    audienceId: audience.id,
    kind: data.kind,
    title: data.title,
    description: data.description,
    createdBy: auth.userId,
    ...fields,
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'resource.created', details: data.title });
  if (data.notify) await sendToGroup(auth, id, { email: false, isNew: true });
  return getOne(auth, id);
}

// Edit a document (title / description / body). Files can only get a new version.
export async function update(auth, id, data) {
  const resource = await getManageableOrFail(auth, id);
  if (resource.kind === 'file' && data.body !== undefined) throw new AppError(422, 'Files can’t be edited here — upload a new version instead');

  await withTransaction(async (db) => {
    const locked = await resourceModel.lock(auth.orgId, id, db);
    const fields = {};
    if (data.title !== undefined) fields.title = data.title;
    if (data.description !== undefined) fields.description = data.description || null;
    if (data.body !== undefined) fields.body = cleanHtml(data.body);
    const contentChanged = (fields.body !== undefined && fields.body !== locked.body) || (fields.title !== undefined && fields.title !== locked.title);
    if (contentChanged) {
      await resourceModel.saveVersion(locked, auth.userId, db);
      fields.version = locked.version + 1;
    }
    fields.updated_by = auth.userId;
    await resourceModel.update(auth.orgId, id, fields, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'resource.updated', details: resource.title });
  return getOne(auth, id);
}

// Upload a new version of a file
export async function replaceFile(auth, id, file) {
  const resource = await getManageableOrFail(auth, id);
  if (resource.kind !== 'file') throw new AppError(422, 'Only uploaded files get new versions — edit documents directly');
  if (!file) throw new AppError(422, 'Choose a file to upload', { file: 'Choose a file' });
  const stored = await storeFile(file, { orgId: auth.orgId, subfolder: 'resources', devMaxKb: 2048 });
  await withTransaction(async (db) => {
    const locked = await resourceModel.lock(auth.orgId, id, db);
    await resourceModel.saveVersion(locked, auth.userId, db);
    await resourceModel.update(auth.orgId, id, {
      file_url: stored.url, file_name: file.originalname, file_type: file.mimetype, file_size: file.size, file_public_id: stored.publicId,
      version: locked.version + 1, updated_by: auth.userId,
    }, db);
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'resource.new_version', details: `${resource.title}: ${file.originalname}` });
  return getOne(auth, id);
}

// An older version (to read, or to download an older file)
export async function getVersion(auth, id, version) {
  const resource = await getVisibleOrFail(auth, id);
  const v = await resourceModel.findVersion(resource.id, version);
  if (!v) throw new AppError(404, 'Version not found');
  return { ...v, kind: resource.kind };
}

export async function remove(auth, id) {
  const resource = await getManageableOrFail(auth, id);
  const publicIds = [resource.file_public_id, ...(await resourceModel.versionPublicIds(resource.id))];
  await resourceModel.remove(auth.orgId, id);
  for (const publicId of publicIds) await deleteFile(publicId, 'raw');
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'resource.deleted', details: resource.title });
}

// "Send to team": tell everyone in the group (bell, and email if asked)
export async function sendToGroup(auth, id, { email, message, isNew = false }) {
  const resource = await getManageableOrFail(auth, id);
  const members = (await audienceModel.members(auth.orgId, audienceOf(resource))).filter((m) => m.user_id !== auth.userId);
  const title = isNew ? `${auth.userName} shared “${resource.title}” with ${resource.audience_name}` : `${auth.userName} sent you “${resource.title}”`;
  const sent = await notify(auth.orgId, members.map((m) => m.user_id), {
    type: 'resource.shared',
    title,
    body: message || resource.description || null,
    link: `/resources/${resource.id}`,
    actorUserId: auth.userId,
  });
  if (email) {
    await emailEach(members, (m) =>
      resourceEmail({ firstName: m.first_name, sender: auth.userName, title: resource.title, message: message || resource.description, link: `${env.clientUrls[0]}/resources/${resource.id}` })
    );
  }
  return { sent, people: members.length };
}
