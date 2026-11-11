import { env } from '../../config/env.js';
import { call, readIdToken } from './common.js';

// ============================================================
// OUTLOOK — Microsoft sign-in + Microsoft Graph. Same job names as googleMail.js (see common.js).
// "common" sign-in = both Microsoft 365 (work) and personal Outlook.com / Hotmail accounts.
//
// Permissions: Mail.Send (send), Mail.ReadWrite (inbox + mark read + reply drafts),
// User.Read (their address), offline_access (a refresh token). No yearly assessment;
// a company's 365 admin may need to approve Workard once for their staff.
// ============================================================

const cfg = () => env.mail.microsoft;
const SEND_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.Send'];
const READ_SCOPE = 'Mail.ReadWrite';
const redirectUri = () => `${env.mail.callbackBase}/api/mail/oauth/microsoft/callback`;
const tokenUrl = () => `${env.mail.microsoftAuthBase}/common/oauth2/v2.0/token`;
const api = (path) => `${env.mail.microsoftApiBase}/v1.0/me${path}`;

export const isConfigured = () => Boolean(cfg().clientId && cfg().clientSecret);

// Microsoft has no "restricted" inbox scope like Google, so the inbox is always asked for
export function authUrl({ state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: cfg().clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: [...SEND_SCOPES, READ_SCOPE].join(' '),
    prompt: 'select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${env.mail.microsoftAuthBase}/common/oauth2/v2.0/authorize?${params}`;
}

export async function exchangeCode({ code, codeVerifier }) {
  const data = await call(tokenUrl(), {
    method: 'POST',
    form: {
      client_id: cfg().clientId,
      client_secret: cfg().clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      scope: [...SEND_SCOPES, READ_SCOPE].join(' '),
    },
  });
  const me = await call(api('?$select=mail,userPrincipalName,displayName'), { token: data.access_token });
  const idToken = readIdToken(data.id_token);
  const scopes = data.scope || '';
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scopes,
    email: String(me.mail || me.userPrincipalName || idToken.email || '').toLowerCase(),
    name: me.displayName || idToken.name || null,
    isWorkspace: false,
    canRead: scopes.toLowerCase().includes('mail.readwrite'),
  };
}

// Microsoft may hand back a NEW refresh token each time — we keep it
export async function refresh(refreshToken) {
  const data = await call(tokenUrl(), {
    method: 'POST',
    form: { client_id: cfg().clientId, client_secret: cfg().clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token', scope: [...SEND_SCOPES, READ_SCOPE].join(' ') },
  });
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

// Microsoft has no "revoke this one token" call. Deleting the token on our side ends Workard's
// access; people can also remove Workard at https://account.live.com/consent/Manage or myapps.microsoft.com.
export async function revoke() {}

// ---------- Sending ----------
const recipients = (list = []) => list.map((r) => ({ emailAddress: { address: r.email, ...(r.name ? { name: r.name } : {}) } }));
const fileAttachments = (list = []) =>
  list.map((f) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: f.filename, contentType: f.mimeType || 'application/octet-stream', contentBytes: f.content.toString('base64') }));

// Draft first, then send — so we learn the message id and conversation (thread) id
export async function send(token, { to, cc, bcc, subject, html, attachments }) {
  const draft = await call(api('/messages'), {
    method: 'POST',
    token,
    json: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: recipients(to),
      ccRecipients: recipients(cc),
      bccRecipients: recipients(bcc),
      attachments: fileAttachments(attachments),
    },
  });
  await call(api(`/messages/${encodeURIComponent(draft.id)}/send`), { method: 'POST', token });
  return { messageId: draft.id, threadId: draft.conversationId };
}

// ---------- Reading ----------
const person = (r) => (r?.emailAddress ? { name: r.emailAddress.name || null, email: String(r.emailAddress.address || '').toLowerCase() } : null);
const PAGE = 20;

// Outlook lists messages; we show each as a "thread" keyed by its conversation
export async function listThreads(token, { search, pageToken }) {
  const skip = Number(pageToken) || 0;
  const select = '$select=id,subject,from,receivedDateTime,bodyPreview,isRead,conversationId,hasAttachments';
  const url = search
    ? api(`/mailFolders/inbox/messages?${select}&$top=${PAGE}&$skip=${skip}&$search=${encodeURIComponent(`"${search.replace(/"/g, '')}"`)}`)
    : api(`/mailFolders/inbox/messages?${select}&$top=${PAGE}&$skip=${skip}&$orderby=receivedDateTime desc`);
  const data = await call(url, { token });
  const seen = new Set();
  const threads = [];
  for (const m of data.value || []) {
    if (seen.has(m.conversationId)) continue; // newest message of each conversation only
    seen.add(m.conversationId);
    threads.push({
      id: m.conversationId,
      subject: m.subject || '(no subject)',
      from: person(m.from),
      snippet: m.bodyPreview || '',
      date: m.receivedDateTime,
      unread: !m.isRead,
      hasAttachments: Boolean(m.hasAttachments),
      messageCount: null,
    });
  }
  return { threads, nextPageToken: (data.value || []).length === PAGE ? String(skip + PAGE) : null };
}

export async function getThread(token, threadId) {
  const filter = encodeURIComponent(`conversationId eq '${String(threadId).replace(/'/g, "''")}'`);
  const data = await call(
    api(`/messages?$filter=${filter}&$top=50&$select=id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,body,isRead,hasAttachments,internetMessageId`),
    { token }
  );
  const list = (data.value || []).sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)));
  const messages = await Promise.all(
    list.map(async (m) => {
      const atts = m.hasAttachments ? await call(api(`/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`), { token }) : { value: [] };
      return {
        id: m.id,
        from: person(m.from),
        to: (m.toRecipients || []).map(person),
        cc: (m.ccRecipients || []).map(person),
        replyTo: (m.replyTo || []).map(person),
        date: m.receivedDateTime,
        subject: m.subject,
        messageIdHeader: m.internetMessageId,
        references: '',
        unread: !m.isRead,
        html: m.body?.contentType === 'html' ? m.body.content : '',
        text: m.body?.contentType === 'text' ? m.body.content : '',
        attachments: (atts.value || []).filter((a) => !a.isInline).map((a) => ({ id: a.id, name: a.name, mimeType: a.contentType, size: a.size })),
      };
    })
  );
  return { id: threadId, subject: messages[0]?.subject || '(no subject)', messages };
}

export async function getAttachment(token, messageId, attachmentId) {
  const data = await call(api(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`), { token });
  return { content: Buffer.from(data.contentBytes || '', 'base64') };
}

// Reply / reply all / forward: Outlook keeps the conversation together only if we use its own
// createReply / createReplyAll / createForward. We then put in our text and the chosen people.
export async function reply(token, { threadId, messageId, mode, to, cc, bcc, subject, html, attachments }) {
  const action = { reply: 'createReply', reply_all: 'createReplyAll', forward: 'createForward' }[mode] || 'createReply';
  const draft = await call(api(`/messages/${encodeURIComponent(messageId)}/${action}`), { method: 'POST', token, json: {} });
  await call(api(`/messages/${encodeURIComponent(draft.id)}`), {
    method: 'PATCH',
    token,
    json: {
      subject,
      body: { contentType: 'HTML', content: `${html}${draft.body?.content || ''}` }, // our text above the quoted original
      toRecipients: recipients(to),
      ccRecipients: recipients(cc),
      bccRecipients: recipients(bcc),
    },
  });
  for (const att of fileAttachments(attachments)) {
    await call(api(`/messages/${encodeURIComponent(draft.id)}/attachments`), { method: 'POST', token, json: att });
  }
  await call(api(`/messages/${encodeURIComponent(draft.id)}/send`), { method: 'POST', token });
  return { messageId: draft.id, threadId: draft.conversationId || threadId };
}

export async function markRead(token, threadId) {
  const { messages } = await getThread(token, threadId);
  await Promise.all(
    messages.filter((m) => m.unread).map((m) => call(api(`/messages/${encodeURIComponent(m.id)}`), { method: 'PATCH', token, json: { isRead: true } }))
  );
}
