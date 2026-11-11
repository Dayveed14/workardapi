import { env } from '../../config/env.js';
import { buildMime, toBase64Url, fromBase64Url } from '../../utils/mime.js';
import { call, readIdToken, parseAddressList, MailProviderError } from './common.js';

// ============================================================
// GMAIL — Google OAuth + the Gmail API. Same job names as microsoftMail.js (see common.js).
//
// Permissions (scopes):
//   gmail.send    — "sensitive": app verification only. Everyone gets this.
//   gmail.modify  — "restricted": read the inbox, mark read. Asked for only when the inbox
//                   is allowed (MAIL_GOOGLE_INBOX), because it needs Google's yearly assessment.
// ============================================================

const cfg = () => env.mail.google;
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const READ = 'https://www.googleapis.com/auth/gmail.modify';
const redirectUri = () => `${env.mail.callbackBase}/api/mail/oauth/google/callback`;
const api = (path) => `${env.mail.googleApiBase}/gmail/v1/users/me${path}`;

export const isConfigured = () => Boolean(cfg().clientId && cfg().clientSecret);

export function authUrl({ state, codeChallenge, withInbox }) {
  const params = new URLSearchParams({
    client_id: cfg().clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: ['openid', 'email', 'profile', SEND, ...(withInbox ? [READ] : [])].join(' '),
    access_type: 'offline', // gives us a refresh token
    prompt: 'consent', //      always return a refresh token, even on reconnect
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${env.mail.googleAuthBase}/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode({ code, codeVerifier }) {
  const data = await call(`${env.mail.googleTokenBase}/token`, {
    method: 'POST',
    form: { code, code_verifier: codeVerifier, client_id: cfg().clientId, client_secret: cfg().clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' },
  });
  if (!data.refresh_token) throw new MailProviderError('Google did not give Workard lasting access. Please try connecting again.');
  const profile = readIdToken(data.id_token);
  const scopes = data.scope || '';
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scopes,
    email: String(profile.email || '').toLowerCase(),
    name: profile.name || null,
    isWorkspace: Boolean(profile.hd), // "hd" (hosted domain) is only present for Google Workspace accounts
    canRead: scopes.split(' ').includes(READ),
  };
}

export async function refresh(refreshToken) {
  const data = await call(`${env.mail.googleTokenBase}/token`, {
    method: 'POST',
    form: { refresh_token: refreshToken, client_id: cfg().clientId, client_secret: cfg().clientSecret, grant_type: 'refresh_token' },
  });
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function revoke(refreshToken) {
  await call(`${env.mail.googleTokenBase}/revoke`, { method: 'POST', form: { token: refreshToken } });
}

export async function send(token, message) {
  const raw = toBase64Url(buildMime(message));
  const data = await call(api('/messages/send'), { method: 'POST', token, json: message.threadId ? { raw, threadId: message.threadId } : { raw } });
  return { messageId: data.id, threadId: data.threadId };
}

// ---------- Reading (only when the inbox is allowed) ----------
const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

export async function listThreads(token, { search, pageToken }) {
  const params = new URLSearchParams({ maxResults: '20', labelIds: 'INBOX' });
  if (search) params.set('q', search);
  if (pageToken) params.set('pageToken', pageToken);
  const data = await call(api(`/threads?${params}`), { token });
  // One small request per thread for its subject / sender / date (Gmail has no "list with headers")
  const threads = await Promise.all(
    (data.threads || []).map(async (t) => {
      const full = await call(api(`/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`), { token });
      const messages = full.messages || [];
      const first = messages[0] || {};
      const last = messages[messages.length - 1] || {};
      return {
        id: t.id,
        subject: header(first.payload?.headers, 'Subject') || '(no subject)',
        from: parseAddressList(header(last.payload?.headers, 'From'))[0] || null,
        snippet: last.snippet || t.snippet || '',
        date: last.internalDate ? new Date(Number(last.internalDate)).toISOString() : null,
        unread: messages.some((m) => (m.labelIds || []).includes('UNREAD')),
        hasAttachments: messages.some((m) => (m.payload?.parts || []).some((p) => p.filename)),
        messageCount: messages.length,
      };
    })
  );
  return { threads, nextPageToken: data.nextPageToken || null };
}

// Walk the MIME tree: find the html/text bodies and the attachments
function readParts(part, out) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({ id: part.body.attachmentId, name: part.filename, mimeType: part.mimeType, size: part.body.size || 0 });
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    out.html += fromBase64Url(part.body.data).toString('utf8');
  } else if (part.mimeType === 'text/plain' && part.body?.data) {
    out.text += fromBase64Url(part.body.data).toString('utf8');
  }
  for (const child of part.parts || []) readParts(child, out);
  return out;
}

export async function getThread(token, threadId) {
  const data = await call(api(`/threads/${encodeURIComponent(threadId)}?format=full`), { token });
  const messages = (data.messages || []).map((m) => {
    const h = m.payload?.headers || [];
    const body = readParts(m.payload, { html: '', text: '', attachments: [] });
    return {
      id: m.id,
      from: parseAddressList(header(h, 'From'))[0] || null,
      to: parseAddressList(header(h, 'To')),
      cc: parseAddressList(header(h, 'Cc')),
      replyTo: parseAddressList(header(h, 'Reply-To')),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      subject: header(h, 'Subject'),
      messageIdHeader: header(h, 'Message-ID') || header(h, 'Message-Id'),
      references: header(h, 'References'),
      unread: (m.labelIds || []).includes('UNREAD'),
      html: body.html,
      text: body.text,
      attachments: body.attachments,
    };
  });
  return { id: data.id, subject: messages[0]?.subject || '(no subject)', messages };
}

export async function getAttachment(token, messageId, attachmentId) {
  const data = await call(api(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`), { token });
  return { content: fromBase64Url(data.data) };
}

// Reply / reply all / forward: a normal send in the same thread, with the threading headers
export async function reply(token, { threadId, messageId, original, ...message }) {
  const inReplyTo = message.mode === 'forward' ? undefined : original?.messageIdHeader || undefined;
  const references = inReplyTo ? [original?.references, inReplyTo].filter(Boolean).join(' ') : undefined;
  return send(token, { ...message, threadId, inReplyTo, references });
}

export async function markRead(token, threadId) {
  await call(api(`/threads/${encodeURIComponent(threadId)}/modify`), { method: 'POST', token, json: { removeLabelIds: ['UNREAD'] } });
}
