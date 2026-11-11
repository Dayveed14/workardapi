// ============================================================
// FAKE Google (OAuth + Gmail API) and Microsoft (OAuth + Graph) servers for tests only.
// They answer like the real ones for the calls Workard makes, so connecting, sending,
// the inbox and replies can be tested with no real accounts.
//
// The test "visits" the sign-in link (adding &login_hint=<email>, and &fake_hd=<domain> for a
// Google Workspace account). The fake answers with a redirect to Workard's callback, just as
// Google/Microsoft do after the person clicks Allow. PKCE is checked like the real thing.
// ============================================================
import express from 'express';
import crypto from 'node:crypto';

export function startFakeMail() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: false }));

  const id = () => crypto.randomBytes(6).toString('hex');
  const s = {
    codes: {}, //    code → { email, name, hd, scope, challenge, provider }
    access: {}, //   access token → email
    refresh: {}, //  refresh token → { email, scope, revoked }
    gmail: {}, //    email → { threads: { id: [messages] } }
    outlook: {}, //  email → [messages]  (each with conversationId, folder 'inbox'|'drafts'|'sent')
    sent: [], //     everything sent: { provider, from, raw?, message }
    tokenCalls: 0,
  };

  const issueTokens = (email, scope) => {
    const accessToken = `at_${id()}`;
    const refreshToken = `rt_${id()}`;
    s.access[accessToken] = email;
    s.refresh[refreshToken] = { email, scope, revoked: false };
    return { accessToken, refreshToken };
  };
  const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const who = (req) => s.access[String(req.headers.authorization || '').replace('Bearer ', '')];
  const authed = (req, res, next) => (who(req) ? next() : res.status(401).json({ error: { message: 'Invalid token' } }));

  // ---------- Sign-in pages: "Allow" → back to Workard with a code ----------
  function authorize(provider) {
    return (req, res) => {
      const code = `code_${id()}`;
      s.codes[code] = {
        provider,
        email: String(req.query.login_hint || 'someone@gmail.com').toLowerCase(),
        name: req.query.fake_name || 'Test Person',
        hd: req.query.fake_hd || null,
        // fake_untick: the person left "send email" unticked on the consent screen
        scope: String(req.query.scope || '').split(' ').filter((x) => !(req.query.fake_untick && /gmail\.send|Mail\.Send/.test(x))).join(' '),
        challenge: req.query.code_challenge,
      };
      const back = new URL(req.query.redirect_uri);
      if (req.query.fake_deny) back.searchParams.set('error', 'access_denied');
      else back.searchParams.set('code', code);
      back.searchParams.set('state', req.query.state);
      res.redirect(back.toString());
    };
  }
  app.get('/o/oauth2/v2/auth', authorize('google'));
  app.get('/common/oauth2/v2.0/authorize', authorize('microsoft'));

  function token(provider) {
    return (req, res) => {
      s.tokenCalls += 1;
      const b = req.body;
      if (b.grant_type === 'authorization_code') {
        const c = s.codes[b.code];
        delete s.codes[b.code]; // a code works once
        if (!c || c.provider !== provider) return res.status(400).json({ error: 'invalid_grant' });
        const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
        if (challenge !== c.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE check failed' });
        const t = issueTokens(c.email, c.scope);
        if (provider === 'microsoft') s.outlook[c.email] = s.outlook[c.email] || [];
        else s.gmail[c.email] = s.gmail[c.email] || { threads: {} };
        return res.json({
          access_token: t.accessToken,
          refresh_token: t.refreshToken,
          expires_in: 3600,
          scope: c.scope,
          id_token: idToken({ email: c.email, name: c.name, ...(c.hd ? { hd: c.hd } : {}) }),
        });
      }
      if (b.grant_type === 'refresh_token') {
        const r = s.refresh[b.refresh_token];
        if (!r || r.revoked) return res.status(400).json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const accessToken = `at_${id()}`;
        s.access[accessToken] = r.email;
        if (provider === 'microsoft') {
          // Microsoft rotates refresh tokens
          r.revoked = true;
          const t = issueTokens(r.email, r.scope);
          return res.json({ access_token: t.accessToken, refresh_token: t.refreshToken, expires_in: 3600 });
        }
        return res.json({ access_token: accessToken, expires_in: 3600 });
      }
      res.status(400).json({ error: 'unsupported_grant_type' });
    };
  }
  app.post('/token', token('google'));
  app.post('/common/oauth2/v2.0/token', token('microsoft'));
  app.post('/revoke', (req, res) => {
    const r = s.refresh[req.body.token];
    if (r) r.revoked = true;
    res.json({});
  });

  // ---------- Gmail ----------
  const decodeRaw = (raw) => Buffer.from(String(raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const headerOf = (raw, name) => (raw.match(new RegExp(`^${name}: (.*)$`, 'mi')) || [])[1] || '';
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
  const gmailBox = (email) => (s.gmail[email] = s.gmail[email] || { threads: {} });
  const gmailPayload = (m) => ({
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: m.from },
      { name: 'To', value: m.to || '' },
      { name: 'Cc', value: m.cc || '' },
      { name: 'Subject', value: m.subject },
      { name: 'Message-ID', value: m.messageIdHeader },
      ...(m.references ? [{ name: 'References', value: m.references }] : []),
    ],
    parts: [
      { mimeType: 'text/html', body: { data: b64(m.html || '') } },
      ...(m.attachments || []).map((a) => ({ filename: a.name, mimeType: a.mimeType, body: { attachmentId: a.id, size: a.data.length } })),
    ],
  });
  const gmailMessage = (m) => ({ id: m.id, threadId: m.threadId, labelIds: m.labels, snippet: (m.html || '').replace(/<[^>]+>/g, '').slice(0, 80), internalDate: String(m.date), payload: gmailPayload(m) });

  // test helper: take "send" away from everything already issued (an old connection made without the tick)
  s.dropSendPermission = () => {
    for (const r of Object.values(s.refresh)) r.scope = r.scope.split(' ').filter((x) => !/gmail\.send|Mail\.Send/.test(x)).join(' ');
    s.noSend = true;
  };
  app.post('/gmail/v1/users/me/messages/send', authed, (req, res) => {
    if (s.noSend) return res.status(403).json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
    const email = who(req);
    const raw = decodeRaw(req.body.raw);
    const box = gmailBox(email);
    const threadId = req.body.threadId && box.threads[req.body.threadId] ? req.body.threadId : `t_${id()}`;
    const message = { id: `m_${id()}`, threadId, labels: ['SENT'], from: headerOf(raw, 'From'), to: headerOf(raw, 'To'), cc: headerOf(raw, 'Cc'), subject: headerOf(raw, 'Subject'), html: '', date: Date.now(), messageIdHeader: `<${id()}@fake>` };
    (box.threads[threadId] = box.threads[threadId] || []).push(message);
    s.sent.push({ provider: 'google', from: email, raw, threadId, inReplyTo: headerOf(raw, 'In-Reply-To'), bcc: headerOf(raw, 'Bcc') });
    res.json({ id: message.id, threadId });
  });
  app.get('/gmail/v1/users/me/threads', authed, (req, res) => {
    const box = gmailBox(who(req));
    const threads = Object.entries(box.threads)
      .filter(([, msgs]) => msgs.some((m) => m.labels.includes('INBOX')))
      .filter(([, msgs]) => !req.query.q || msgs.some((m) => `${m.subject} ${m.html}`.toLowerCase().includes(String(req.query.q).toLowerCase())))
      .map(([tid]) => ({ id: tid }));
    res.json({ threads });
  });
  app.get('/gmail/v1/users/me/threads/:id', authed, (req, res) => {
    const msgs = gmailBox(who(req)).threads[req.params.id];
    if (!msgs) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ id: req.params.id, messages: msgs.map(gmailMessage) });
  });
  app.post('/gmail/v1/users/me/threads/:id/modify', authed, (req, res) => {
    for (const m of gmailBox(who(req)).threads[req.params.id] || []) m.labels = m.labels.filter((l) => !(req.body.removeLabelIds || []).includes(l));
    res.json({});
  });
  app.get('/gmail/v1/users/me/messages/:mid/attachments/:aid', authed, (req, res) => {
    for (const msgs of Object.values(gmailBox(who(req)).threads)) {
      const att = msgs.find((m) => m.id === req.params.mid)?.attachments?.find((a) => a.id === req.params.aid);
      if (att) return res.json({ data: Buffer.from(att.data).toString('base64url'), size: att.data.length });
    }
    res.status(404).json({ error: { message: 'Not found' } });
  });

  // ---------- Microsoft Graph ----------
  const outlookBox = (email) => (s.outlook[email] = s.outlook[email] || []);
  const addr = (list = []) => list.map((r) => ({ emailAddress: { address: r.emailAddress.address, name: r.emailAddress.name } }));
  const graphMessage = (m) => ({
    id: m.id,
    conversationId: m.conversationId,
    subject: m.subject,
    from: { emailAddress: { address: m.from, name: m.fromName || null } },
    toRecipients: m.toRecipients || [],
    ccRecipients: m.ccRecipients || [],
    bccRecipients: m.bccRecipients || [],
    replyTo: [],
    receivedDateTime: new Date(m.date).toISOString(),
    body: { contentType: 'html', content: m.html || '' },
    bodyPreview: (m.html || '').replace(/<[^>]+>/g, '').slice(0, 80),
    isRead: Boolean(m.isRead),
    hasAttachments: Boolean(m.attachments?.length),
    internetMessageId: `<${m.id}@fake>`,
  });
  const findMsg = (req) => outlookBox(who(req)).find((m) => m.id === req.params.mid);

  app.get('/v1.0/me', authed, (req, res) => res.json({ mail: who(req), displayName: 'Outlook Person', userPrincipalName: who(req) }));
  app.post('/v1.0/me/messages', authed, (req, res) => {
    const email = who(req);
    const b = req.body;
    const m = {
      id: `om_${id()}`, conversationId: `conv_${id()}`, folder: 'drafts', subject: b.subject, from: email, html: b.body?.content || '',
      toRecipients: addr(b.toRecipients), ccRecipients: addr(b.ccRecipients), bccRecipients: addr(b.bccRecipients),
      attachments: (b.attachments || []).map((a) => ({ id: `oa_${id()}`, name: a.name, contentType: a.contentType, data: Buffer.from(a.contentBytes, 'base64') })),
      date: Date.now(), isRead: true,
    };
    outlookBox(email).push(m);
    res.status(201).json(graphMessage(m));
  });
  app.post('/v1.0/me/messages/:mid/send', authed, (req, res) => {
    const m = findMsg(req);
    if (!m) return res.status(404).json({ error: { message: 'Not found' } });
    m.folder = 'sent';
    s.sent.push({ provider: 'microsoft', from: who(req), message: graphMessage(m), attachments: m.attachments.map((a) => a.name), replyOf: m.replyOf || null });
    res.status(202).end();
  });
  app.post('/v1.0/me/messages/:mid/:action(createReply|createReplyAll|createForward)', authed, (req, res) => {
    const original = findMsg(req);
    if (!original) return res.status(404).json({ error: { message: 'Not found' } });
    const draft = {
      id: `om_${id()}`, conversationId: original.conversationId, folder: 'drafts', subject: original.subject, from: who(req),
      html: `<blockquote>${original.html}</blockquote>`, toRecipients: [], ccRecipients: [], bccRecipients: [],
      attachments: req.params.action === 'createForward' ? [...(original.attachments || [])] : [], date: Date.now(), isRead: true, replyOf: original.id,
    };
    outlookBox(who(req)).push(draft);
    res.status(201).json(graphMessage(draft));
  });
  app.patch('/v1.0/me/messages/:mid', authed, (req, res) => {
    const m = findMsg(req);
    if (!m) return res.status(404).json({ error: { message: 'Not found' } });
    const b = req.body;
    if ('isRead' in b) m.isRead = b.isRead;
    if (b.subject) m.subject = b.subject;
    if (b.body) m.html = b.body.content;
    if (b.toRecipients) m.toRecipients = addr(b.toRecipients);
    if (b.ccRecipients) m.ccRecipients = addr(b.ccRecipients);
    if (b.bccRecipients) m.bccRecipients = addr(b.bccRecipients);
    res.json(graphMessage(m));
  });
  app.post('/v1.0/me/messages/:mid/attachments', authed, (req, res) => {
    const m = findMsg(req);
    m.attachments.push({ id: `oa_${id()}`, name: req.body.name, contentType: req.body.contentType, data: Buffer.from(req.body.contentBytes, 'base64') });
    res.status(201).json({});
  });
  app.get('/v1.0/me/mailFolders/inbox/messages', authed, (req, res) => {
    const top = Number(req.query.$top || 20);
    const skip = Number(req.query.$skip || 0);
    const q = String(req.query.$search || '').replace(/"/g, '').toLowerCase();
    const list = outlookBox(who(req))
      .filter((m) => m.folder === 'inbox' && (!q || `${m.subject} ${m.html}`.toLowerCase().includes(q)))
      .sort((a, b) => b.date - a.date);
    res.json({ value: list.slice(skip, skip + top).map(graphMessage) });
  });
  app.get('/v1.0/me/messages', authed, (req, res) => {
    const conv = (String(req.query.$filter || '').match(/conversationId eq '(.*)'/) || [])[1];
    res.json({ value: outlookBox(who(req)).filter((m) => m.conversationId === conv && m.folder !== 'drafts').map(graphMessage) });
  });
  app.get('/v1.0/me/messages/:mid/attachments', authed, (req, res) => {
    res.json({ value: (findMsg(req)?.attachments || []).map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.data.length, isInline: false })) });
  });
  app.get('/v1.0/me/messages/:mid/attachments/:aid', authed, (req, res) => {
    const att = findMsg(req)?.attachments?.find((a) => a.id === req.params.aid);
    if (!att) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ contentBytes: att.data.toString('base64') });
  });

  // ---------- Test helpers: put an email in someone's inbox ----------
  function receiveGmail(toEmail, { from, subject, html, attachments = [] }) {
    const threadId = `t_${id()}`;
    const message = { id: `m_${id()}`, threadId, labels: ['INBOX', 'UNREAD'], from, to: toEmail, subject, html, date: Date.now(), messageIdHeader: `<${id()}@sender.test>`, attachments: attachments.map((a) => ({ id: `a_${id()}`, ...a })) };
    gmailBox(toEmail).threads[threadId] = [message];
    return { threadId, messageId: message.id };
  }
  function receiveOutlook(toEmail, { from, subject, html, attachments = [] }) {
    const [, fromName, fromEmail] = String(from).match(/^\s*(.*?)\s*<([^>]+)>\s*$/) || [null, null, from];
    const m = {
      id: `om_${id()}`, conversationId: `conv_${id()}`, folder: 'inbox', subject, from: fromEmail, fromName, html, date: Date.now(), isRead: false,
      toRecipients: [{ emailAddress: { address: toEmail } }], attachments: attachments.map((a) => ({ id: `oa_${id()}`, name: a.name, contentType: a.mimeType, data: a.data })),
    };
    outlookBox(toEmail).push(m);
    return { threadId: m.conversationId, messageId: m.id };
  }
  // Same, over HTTP (for the browser walkthrough)
  app.post('/__test/receive/:provider', (req, res) => {
    const b = req.body;
    const attachments = (b.attachments || []).map((a) => ({ name: a.name, mimeType: a.mimeType, data: Buffer.from(a.text || '') }));
    const fn = req.params.provider === 'microsoft' ? receiveOutlook : receiveGmail;
    res.json(fn(b.to, { from: b.from, subject: b.subject, html: b.html, attachments }));
  });
  const revokeAll = (email) => Object.values(s.refresh).forEach((r) => r.email === email && (r.revoked = true));

  const server = app.listen(0);
  return { server, state: s, url: `http://127.0.0.1:${server.address().port}`, receiveGmail, receiveOutlook, revokeAll };
}
