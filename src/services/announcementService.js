import * as announcementModel from '../models/announcementModel.js';
import * as audienceModel from '../models/audienceModel.js';
import * as auditModel from '../models/auditModel.js';
import { checkAudience, groupsFor } from './audienceService.js';
import { notify, emailEach } from './notificationService.js';
import { storeFile, deleteFile } from './uploadService.js';
import { announcementEmail } from './emailService.js';
import { memberOfCondition, canTarget } from '../utils/audience.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// ANNOUNCEMENTS — managers post to a group (everyone, a branch, a department or a team),
// staff comment underneath. Everyone in the group gets a bell notification
// (and an email if the poster ticks "Also email everyone").
//
// Who can post where: the announcements.post scope (see utils/audience.js).
// Who sees a post:    people in its group, its author, and anyone whose
//                     announcements.post scope is "all".
// "Seen by": every post the feed shows is marked seen. Posts marked
//                     "needs acknowledgement" also get an "I've read this" button.
// ============================================================

const audienceOf = (a) => ({ type: a.audience_type, id: a.audience_id });

function visibleCondition(auth) {
  if (auth.permissions['announcements.post'] === 'all') return { sql: '1=1', params: [] };
  const member = memberOfCondition(auth.employee, 'a');
  return { sql: `(${member.sql} OR a.author_user_id = ?)`, params: [...member.params, auth.userId] };
}

// Author, or someone allowed to post to the post's group, may pin / edit / delete it and see who read it
async function canManage(auth, post) {
  if (post.author_user_id === auth.userId) return true;
  const audience = audienceOf(post);
  const team = audience.type === 'team' ? await audienceModel.findTeam(auth.orgId, audience.id) : null;
  return canTarget(auth.permissions['announcements.post'], auth.employee, audience, team);
}

async function getVisibleOrFail(auth, id) {
  const post = await announcementModel.findById(auth.orgId, id);
  if (!post) throw new AppError(404, 'Announcement not found');
  if (post.author_user_id === auth.userId || auth.permissions['announcements.post'] === 'all') return post;
  const cond = visibleCondition(auth);
  const visible = await announcementModel.listVisible(auth.orgId, { sql: `a.id = ? AND ${cond.sql}`, params: [id, ...cond.params] }, {});
  if (!visible.length) throw new AppError(404, 'Announcement not found');
  return post;
}

// ---------- The feed ----------
export async function listFeed(auth, { before }) {
  const posts = await announcementModel.listVisible(auth.orgId, visibleCondition(auth), { before, limit: 20 });
  const ids = posts.map((p) => p.id);
  await announcementModel.markSeen(ids, auth.userId);
  const [comments, reads] = await Promise.all([announcementModel.commentsFor(ids), announcementModel.readsFor(ids)]);

  const result = [];
  for (const p of posts) {
    const manage = await canManage(auth, p);
    const postReads = reads.filter((r) => r.announcement_id === p.id);
    const mine = postReads.find((r) => r.user_id === auth.userId);
    let stats = null;
    if (manage) {
      // How many of the group have seen / acknowledged it (people with a login only)
      const members = (await audienceModel.members(auth.orgId, audienceOf(p))).filter((m) => m.user_id && m.user_id !== p.author_user_id);
      const memberIds = new Set(members.map((m) => m.user_id));
      stats = {
        audience: members.length,
        seen: postReads.filter((r) => memberIds.has(r.user_id)).length,
        acknowledged: postReads.filter((r) => memberIds.has(r.user_id) && r.acknowledged_at).length,
      };
    }
    result.push({
      ...p,
      comments: comments.filter((c) => c.announcement_id === p.id).map((c) => ({ ...c, mine: c.user_id === auth.userId })),
      acknowledged: Boolean(mine?.acknowledged_at),
      canManage: manage,
      stats,
    });
  }
  return { posts: result, more: posts.length === 20 };
}

// The groups the person may post to (for the "Post to" dropdown)
export const postingGroups = (auth) => groupsFor(auth, 'announcements.post');

// ---------- Posting ----------
export async function createPost(auth, data, file) {
  const audience = { type: data.audienceType, id: data.audienceType === 'company' ? null : data.audienceId };
  await checkAudience(auth, 'announcements.post', audience, 'post to');

  const attachment = file ? await storeFile(file, { orgId: auth.orgId, subfolder: 'announcements' }) : null;
  const id = await announcementModel.create(auth.orgId, {
    authorUserId: auth.userId,
    audienceType: audience.type,
    audienceId: audience.id,
    title: data.title,
    body: data.body,
    isPinned: data.isPinned,
    needsAck: data.needsAck,
    attachmentUrl: attachment?.url,
    attachmentName: file?.originalname,
    attachmentPublicId: attachment?.publicId,
  });
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'announcement.posted', details: data.title });

  // Tell the group: bell for everyone, email too if asked
  const members = (await audienceModel.members(auth.orgId, audience)).filter((m) => m.user_id !== auth.userId);
  await notify(auth.orgId, members.map((m) => m.user_id), {
    type: 'announcement.posted',
    title: `${auth.userName}: ${data.title}`,
    body: data.body.slice(0, 160),
    link: `/announcements#post-${id}`,
    actorUserId: auth.userId,
  });
  if (data.sendEmail) {
    const groupName = await audienceModel.label(auth.orgId, audience);
    await emailEach(members, (m) =>
      announcementEmail({ firstName: m.first_name, author: auth.userName, groupName, title: data.title, body: data.body, link: `${env.clientUrls[0]}/announcements` })
    );
  }
  return announcementModel.findById(auth.orgId, id);
}

export async function updatePost(auth, id, data) {
  const post = await getVisibleOrFail(auth, id);
  if (!(await canManage(auth, post))) throw new AppError(403, 'Only the author or a manager of this group can change it');
  await announcementModel.update(auth.orgId, id, data);
  return announcementModel.findById(auth.orgId, id);
}

export async function deletePost(auth, id) {
  const post = await getVisibleOrFail(auth, id);
  if (!(await canManage(auth, post))) throw new AppError(403, 'Only the author or a manager of this group can delete it');
  await announcementModel.remove(auth.orgId, id);
  await deleteFile(post.attachment_public_id, 'raw');
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'announcement.deleted', details: post.title });
}

// ---------- Comments & reading ----------
export async function addComment(auth, id, { body }) {
  const post = await getVisibleOrFail(auth, id);
  const commentId = await announcementModel.addComment(post.id, auth.userId, body);

  // The author hears about every comment; when the author replies, everyone who commented hears it
  const others = post.author_user_id === auth.userId ? await announcementModel.commenterIds(post.id) : [post.author_user_id];
  await notify(auth.orgId, others, {
    type: 'announcement.comment',
    title: `${auth.userName} commented on “${post.title}”`,
    body: body.slice(0, 160),
    link: `/announcements#post-${post.id}`,
    actorUserId: auth.userId,
  });
  const [comment] = (await announcementModel.commentsFor([post.id])).filter((c) => c.id === commentId);
  return { ...comment, mine: true };
}

export async function deleteComment(auth, commentId) {
  const comment = await announcementModel.findComment(commentId);
  if (!comment) throw new AppError(404, 'Comment not found');
  const post = await getVisibleOrFail(auth, comment.announcement_id);
  if (comment.user_id !== auth.userId && !(await canManage(auth, post))) throw new AppError(403, 'You can only delete your own comments');
  await announcementModel.deleteComment(commentId);
}

export async function acknowledge(auth, id) {
  const post = await getVisibleOrFail(auth, id);
  await announcementModel.acknowledge(post.id, auth.userId);
  return { acknowledged: true };
}

// Who in the group has seen / acknowledged it — for the author and the group's managers
export async function readers(auth, id) {
  const post = await getVisibleOrFail(auth, id);
  if (!(await canManage(auth, post))) throw new AppError(403, 'Only the author or a manager of this group can see this');
  const [members, reads] = await Promise.all([audienceModel.members(auth.orgId, audienceOf(post)), announcementModel.readsFor([post.id])]);
  return members
    .filter((m) => m.user_id !== post.author_user_id)
    .map((m) => {
      const read = reads.find((r) => r.user_id === m.user_id);
      return {
        employeeId: m.id,
        name: `${m.first_name} ${m.last_name}`,
        photoUrl: m.photo_url,
        hasLogin: Boolean(m.user_id),
        seenAt: read?.seen_at || null,
        acknowledgedAt: read?.acknowledged_at || null,
      };
    });
}

// Dashboard: the newest post (pinned first) the person hasn't seen yet
export async function latestUnseen(auth) {
  const cond = visibleCondition(auth);
  const posts = await announcementModel.listVisible(
    auth.orgId,
    { sql: `${cond.sql} AND a.author_user_id <> ? AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?)`, params: [...cond.params, auth.userId, auth.userId] },
    { limit: 3 }
  );
  return posts;
}
