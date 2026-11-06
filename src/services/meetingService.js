import { AccessToken } from 'livekit-server-sdk';
import * as meetingModel from '../models/meetingModel.js';
import * as audienceModel from '../models/audienceModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as auditModel from '../models/auditModel.js';
import { checkAudience, groupsFor } from './audienceService.js';
import { requireProject } from './projectService.js';
import { notify, emailEach } from './notificationService.js';
import { meetingInviteEmail } from './emailService.js';
import { memberOfCondition } from '../utils/audience.js';
import { toDateString, addDays } from '../utils/dates.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// MEETINGS — scheduled here, held on LiveKit (video in the browser).
//   For: chosen people, or a whole team / department / branch / company
//        (a group needs meetings.schedule for it; anyone can invite chosen people)
//   Repeats: none, daily, weekdays (Mon–Fri) or weekly — one row, many "occurrences"
//   Join: Workard gives the person a short-lived LiveKit token for that day's room.
//         Nobody can join a room without one, and only invited people get one.
//   Stand-up: the room shows everyone's tasks — done since the last working day,
//         in progress, coming up, overdue (from the meeting's project only, if it has one)
// Times are wall-clock times in APP_TIMEZONE (Africa/Lagos by default).
// ============================================================

const JOIN_EARLY_MINUTES = 15; // the room opens 15 minutes before
const JOIN_LATE_MINUTES = 60; //  …and stays joinable an hour after the planned end

const datePart = (dt) => String(dt).slice(0, 10);
const timePart = (dt) => String(dt).slice(11, 16);
const weekday = (date) => new Date(`${date}T12:00:00`).getDay(); // 0 = Sunday

// Every date this meeting happens on, between from and to
export function occurrences(meeting, from, to) {
  const first = datePart(meeting.starts_at);
  const last = [to, meeting.repeat_until].filter(Boolean).sort()[0];
  if (meeting.repeat_rule === 'none') return first >= from && first <= to ? [first] : [];
  const dates = [];
  for (let d = first; d <= last && dates.length < 400; d = addDays(d, 1)) {
    if (d < from) continue;
    const day = weekday(d);
    if (meeting.repeat_rule === 'weekdays' && (day === 0 || day === 6)) continue;
    if (meeting.repeat_rule === 'weekly' && day !== weekday(first)) continue;
    dates.push(d);
  }
  return dates;
}

function visibleCondition(auth) {
  const member = memberOfCondition(auth.employee, 'm');
  return {
    sql: `(m.created_by = ? OR ${member.sql}
       OR EXISTS (SELECT 1 FROM meeting_invitees mi WHERE mi.meeting_id = m.id AND mi.employee_id = ?))`,
    params: [auth.userId, ...member.params, auth.employee?.id ?? -1],
  };
}

async function getVisibleOrFail(auth, id) {
  const cond = visibleCondition(auth);
  const meeting = await meetingModel.findById(auth.orgId, id);
  if (!meeting) throw new AppError(404, 'Meeting not found');
  const [visible] = await meetingModel.listVisible(
    auth.orgId,
    { sql: `m.id = ? AND ${cond.sql}`, params: [meeting.id, ...cond.params] },
    { from: '1900-01-01', to: '9999-12-31' }
  );
  if (!visible && meeting.created_by !== auth.userId) throw new AppError(404, 'Meeting not found');
  return meeting;
}

// Everyone invited: the group's members + people added by name
async function peopleFor(orgId, meeting) {
  const extra = await meetingModel.invitees(meeting.id);
  const group = meeting.audience_type === 'people' ? [] : await audienceModel.members(orgId, { type: meeting.audience_type, id: meeting.audience_id });
  const map = new Map();
  for (const p of [...group, ...extra]) map.set(p.id, p);
  return [...map.values()].sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
}

const canEdit = (auth, meeting) => meeting.created_by === auth.userId || auth.role.isOwner;

// ---------- Calendar ----------
export async function listRange(auth, { from, to }) {
  const meetings = await meetingModel.listVisible(auth.orgId, visibleCondition(auth), { from, to });
  const result = [];
  for (const m of meetings) {
    for (const date of occurrences(m, from, to)) {
      result.push({
        meetingId: m.id,
        date,
        startsAt: `${date} ${timePart(m.starts_at)}`,
        durationMinutes: m.duration_minutes,
        title: m.title,
        isStandup: Boolean(m.is_standup),
        repeat: m.repeat_rule,
        audienceName: m.audience_name,
        projectName: m.project_name,
        projectColor: m.project_color,
      });
    }
  }
  return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export const schedulingGroups = (auth) => groupsFor(auth, 'meetings.schedule');

// Everyone you could invite (active colleagues — name, job title and photo only)
export async function inviteList(auth) {
  const { rows } = await employeeModel.list(auth.orgId, { sql: '1=1', params: [] }, { status: 'active', limit: 1000, offset: 0 });
  return rows.map((e) => ({ id: e.id, first_name: e.first_name, last_name: e.last_name, job_title: e.job_title, photo_url: e.photo_url }));
}

export async function getMeeting(auth, id) {
  const meeting = await getVisibleOrFail(auth, id);
  const people = await peopleFor(auth.orgId, meeting);
  const next = occurrences(meeting, toDateString(), addDays(toDateString(), 400))[0] || null;
  return {
    ...meeting,
    people: people.map(({ email: _e, ...p }) => p),
    invitedIds: (await meetingModel.invitees(meeting.id)).map((p) => p.id),
    nextDate: next,
    canEdit: canEdit(auth, meeting),
    videoReady: Boolean(env.livekit.url && env.livekit.apiKey && env.livekit.apiSecret),
  };
}

async function checkInvitees(auth, ids) {
  for (const id of ids) {
    const e = await employeeModel.findById(auth.orgId, id);
    if (!e || e.status !== 'active') throw new AppError(422, 'Someone you invited isn’t an active employee', { inviteeIds: 'Choose active people' });
  }
}

async function tellPeople(auth, meeting, people, verb) {
  const others = people.filter((p) => p.user_id && p.user_id !== auth.userId);
  const when = `${meeting.starts_at.slice(0, 16).replace(' ', ' at ')}${meeting.repeat_rule !== 'none' ? ` (repeats ${meeting.repeat_rule})` : ''}`;
  await notify(auth.orgId, others.map((p) => p.user_id), {
    type: `meeting.${verb}`,
    title: verb === 'cancelled' ? `Cancelled: ${meeting.title}` : `${auth.userName} invited you to “${meeting.title}”`,
    body: when,
    link: `/meetings/${meeting.id}`,
    actorUserId: auth.userId,
  });
  if (verb === 'invited') {
    await emailEach(others, (p) =>
      meetingInviteEmail({ firstName: p.first_name, organiser: auth.userName, title: meeting.title, when, link: `${env.clientUrls[0]}/meetings/${meeting.id}` })
    );
  }
}

export async function createMeeting(auth, data) {
  if (data.audienceType !== 'people') {
    await checkAudience(auth, 'meetings.schedule', { type: data.audienceType, id: data.audienceId }, 'schedule meetings for');
  } else if (!data.inviteeIds.length) {
    throw new AppError(422, 'Invite at least one person', { inviteeIds: 'Choose people' });
  }
  await checkInvitees(auth, data.inviteeIds);
  if (data.projectId) await requireProject(auth, data.projectId);

  const id = await meetingModel.create(auth.orgId, {
    ...data,
    audienceId: data.audienceType === 'people' || data.audienceType === 'company' ? null : data.audienceId,
    startsAt: `${data.date} ${data.time}:00`,
    createdBy: auth.userId,
  });
  // The organiser is always in the meeting
  const invited = [...new Set([...data.inviteeIds, ...(auth.employee ? [auth.employee.id] : [])])];
  await meetingModel.setInvitees(id, invited);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'meeting.scheduled', details: data.title });

  const meeting = await meetingModel.findById(auth.orgId, id);
  await tellPeople(auth, meeting, await peopleFor(auth.orgId, meeting), 'invited');
  return getMeeting(auth, id);
}

export async function updateMeeting(auth, id, data) {
  const meeting = await getVisibleOrFail(auth, id);
  if (!canEdit(auth, meeting)) throw new AppError(403, 'Only the person who scheduled it can change it');
  const fields = {};
  if (data.title !== undefined) fields.title = data.title;
  if (data.description !== undefined) fields.description = data.description || null;
  if (data.date && data.time) fields.starts_at = `${data.date} ${data.time}:00`;
  if (data.durationMinutes !== undefined) fields.duration_minutes = data.durationMinutes;
  if (data.repeat !== undefined) fields.repeat_rule = data.repeat;
  if (data.repeatUntil !== undefined) fields.repeat_until = data.repeatUntil || null;
  if (data.isStandup !== undefined) fields.is_standup = data.isStandup ? 1 : 0;
  await meetingModel.update(auth.orgId, id, fields);

  if (data.inviteeIds) {
    await checkInvitees(auth, data.inviteeIds);
    const before = new Set((await meetingModel.invitees(id)).map((p) => p.id));
    const invited = [...new Set([...data.inviteeIds, ...(auth.employee ? [auth.employee.id] : [])])];
    await meetingModel.setInvitees(id, invited);
    const added = (await meetingModel.invitees(id)).filter((p) => !before.has(p.id));
    if (added.length) await tellPeople(auth, await meetingModel.findById(auth.orgId, id), added, 'invited');
  }
  return getMeeting(auth, id);
}

export async function cancelMeeting(auth, id) {
  const meeting = await getVisibleOrFail(auth, id);
  if (!canEdit(auth, meeting)) throw new AppError(403, 'Only the person who scheduled it can cancel it');
  await meetingModel.update(auth.orgId, id, { cancelled_at: new Date() });
  await tellPeople(auth, meeting, await peopleFor(auth.orgId, meeting), 'cancelled');
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'meeting.cancelled', details: meeting.title });
}

// ---------- Joining (LiveKit) ----------
export async function join(auth, id, date = toDateString(), now = new Date()) {
  const meeting = await getVisibleOrFail(auth, id);
  if (meeting.cancelled_at) throw new AppError(409, 'This meeting was cancelled');
  const people = await peopleFor(auth.orgId, meeting);
  const invited = people.some((p) => p.user_id === auth.userId) || meeting.created_by === auth.userId;
  if (!invited) throw new AppError(403, 'You’re not invited to this meeting');
  if (!occurrences(meeting, date, date).length) throw new AppError(409, 'This meeting doesn’t happen on that day');

  const start = new Date(`${date}T${timePart(meeting.starts_at)}:00`);
  const opens = new Date(start.getTime() - JOIN_EARLY_MINUTES * 60_000);
  const closes = new Date(start.getTime() + (meeting.duration_minutes + JOIN_LATE_MINUTES) * 60_000);
  if (now < opens) throw new AppError(409, `The room opens at ${opens.toTimeString().slice(0, 5)}, ${JOIN_EARLY_MINUTES} minutes before the start`);
  if (now > closes) throw new AppError(409, 'This meeting has ended');

  const { url, apiKey, apiSecret } = env.livekit;
  if (!url || !apiKey || !apiSecret) throw new AppError(503, 'Video meetings aren’t set up yet (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET on the server)');

  const room = `wk-${auth.orgId}-${meeting.id}-${date}`;
  const token = new AccessToken(apiKey, apiSecret, {
    identity: `user-${auth.userId}`,
    name: auth.userName,
    ttl: '3h',
    metadata: JSON.stringify({ employeeId: auth.employee?.id ?? null }),
  });
  token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  await meetingModel.recordJoin(meeting.id, date, auth.userId);
  return { url, token: await token.toJwt(), room, title: meeting.title, isStandup: Boolean(meeting.is_standup) };
}

// ---------- Stand-up board ----------
// Since the last working day: on Monday that's Friday
function lastWorkingDay(date) {
  let d = addDays(date, -1);
  while ([0, 6].includes(weekday(d))) d = addDays(d, -1);
  return d;
}

export async function standup(auth, id, date = toDateString()) {
  const meeting = await getVisibleOrFail(auth, id);
  const people = await peopleFor(auth.orgId, meeting);
  const since = `${lastWorkingDay(date)} 00:00:00`;
  const tasks = await meetingModel.standupTasks(auth.orgId, people.map((p) => p.id), { projectId: meeting.project_id, doneSince: since });
  const joined = new Set((await meetingModel.attendance(meeting.id, date)).map((a) => a.user_id));
  return {
    date,
    since: datePart(since),
    projectName: meeting.project_name,
    people: people.map((p) => {
      const mine = tasks.filter((t) => t.employee_id === p.id);
      return {
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        photo_url: p.photo_url,
        joined: joined.has(p.user_id),
        done: mine.filter((t) => t.status === 'done'),
        doing: mine.filter((t) => t.status === 'in_progress'),
        overdue: mine.filter((t) => t.status === 'todo' && t.due_date && t.due_date < date),
        upNext: mine.filter((t) => t.status === 'todo' && (!t.due_date || t.due_date >= date)).slice(0, 5),
      };
    }),
  };
}
