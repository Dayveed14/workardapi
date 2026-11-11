// ============================================================
// Shared bits for the mail providers (googleMail.js, microsoftMail.js).
// Every provider file does the same jobs with the same names, so mailService
// never needs to know which one is behind a mailbox:
//
//   authUrl({ state, codeChallenge, withInbox })      → the "sign in with …" link
//   exchangeCode({ code, codeVerifier })              → { accessToken, refreshToken, expiresIn, scopes, email, name, isWorkspace, canRead }
//   refresh(refreshToken)                             → { accessToken, refreshToken?, expiresIn }
//   revoke(refreshToken)
//   send(token, { from, to, cc, bcc, subject, html, text, attachments })        → { messageId, threadId }
//   listThreads(token, { search, pageToken })         → { threads: [...], nextPageToken }
//   getThread(token, threadId)                        → { id, subject, messages: [...] }
//   getAttachment(token, messageId, attachmentId)     → { content: Buffer, mimeType, filename }
//   reply(token, { threadId, messageId, mode, from, to, cc, bcc, subject, html, text, attachments }) → { messageId, threadId }
//   markRead(token, threadId)
// ============================================================

// A provider error. needsReconnect = the person cancelled access / changed password → connect again.
export class MailProviderError extends Error {
  constructor(message, { status = 502, needsReconnect = false } = {}) {
    super(message);
    this.status = status;
    this.needsReconnect = needsReconnect;
  }
}

export const MISSING_PERMISSION =
  'Workard was not given permission to send email from this mailbox. Please connect again and, on the Google / Microsoft screen, tick the box that lets Workard send email for you.';

// fetch + JSON + friendly errors
export async function call(url, { method = 'GET', token, json, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new MailProviderError('Could not reach the email provider. Please try again.');
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const reason = data.error_description || data.error?.message || (typeof data.error === 'string' ? data.error : '') || `HTTP ${res.status}`;
    // Missing permission: the person connected without ticking "send email" (Google lets them untick it)
    const missingPermission = res.status === 403 && /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|ErrorAccessDenied/i.test(text);
    if (missingPermission) {
      throw new MailProviderError(MISSING_PERMISSION, { status: 401, needsReconnect: true });
    }
    const needsReconnect = res.status === 401 || data.error === 'invalid_grant';
    throw new MailProviderError(needsReconnect ? 'Your email connection has expired. Please reconnect your mailbox.' : `Email provider: ${reason}`, {
      status: needsReconnect ? 401 : 502,
      needsReconnect,
    });
  }
  return data;
}

// The payload of an id_token (we receive it straight from the provider over HTTPS, so no
// signature check is needed — we only read the email and name from it)
export function readIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// "Ada <ada@x.com>, bisi@y.com" → [{ name, email }]
export function parseAddressList(value) {
  if (!value) return [];
  const out = [];
  for (const part of String(value).match(/("[^"]*"|[^,])+/g) || []) {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) out.push({ name: m[1].trim() || null, email: m[2].trim().toLowerCase() });
    else if (part.includes('@')) out.push({ name: null, email: part.trim().toLowerCase() });
  }
  return out;
}
