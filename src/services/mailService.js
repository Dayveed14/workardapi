import { withTransaction } from '../config/db.js';
import * as sentEmailModel from '../models/sentEmailModel.js';
import * as emailTemplateModel from '../models/emailTemplateModel.js';
import * as employeeModel from '../models/employeeModel.js';
import * as customerModel from '../models/customerModel.js';
import * as organizationModel from '../models/organizationModel.js';
import * as auditModel from '../models/auditModel.js';
import * as mailAccountService from './mailAccountService.js';
import * as invoiceService from './invoiceService.js';
import { getCustomerOrFail } from './accessService.js';
import { storeFile } from './uploadService.js';
import { cleanHtml, cleanEmailHtml, emailPlainText } from '../utils/cleanHtml.js';
import { scopeCondition } from '../utils/scope.js';
import { formatNaira } from '../utils/money.js';
import { formatDateLong } from '../utils/dates.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// MAIL — sending from the person's own Gmail / Outlook, the record of what was sent,
// templates, and the live inbox.
//
//   SEND:  check → (same requestId? return it) → save as "sending" → the provider sends →
//          "sent" (with the provider's ids) or "failed" (with the reason).
//   WHO SEES A SENT EMAIL: the sender + Workard users it went to (to / cc / own bcc).
//          The rule lives in sentEmailModel (VISIBLE).
//   INBOX: fetched live from Google/Microsoft every time — never stored in Workard.
// ============================================================

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // Outlook's simple-send limit; bigger files go as links
const MAX_RECIPIENTS = 50;
const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|com|scr|msi|vbs|js|jar|ps1|sh|apk|dll)$/i;

const lower = (s) => String(s || '').trim().toLowerCase();

// ---------- Address book for the To / Cc boxes ----------
// Staff: everyone active with an email ("anyone can email a staff").
// Customers: only those this person may see (customers.view scope).
export async function contacts(auth, { search = '' }) {
  const like = lower(search);
  const staff = (await employeeModel.emailOptions(auth.orgId))
    .filter((e) => e.email && (!like || `${e.first_name} ${e.last_name} ${e.email}`.toLowerCase().includes(like)))
    .slice(0, 8)
    .map((e) => ({ type: 'staff', id: e.id, name: `${e.first_name} ${e.last_name}`, email: lower(e.email) }));
  let customers = [];
  const scope = auth.permissions['customers.view'];
  if (scope) {
    const { rows } = await customerModel.list(auth.orgId, scopeCondition(scope, auth.employee), { search, limit: 8, offset: 0 });
    customers = rows.filter((c) => c.email).map((c) => ({ type: 'customer', id: c.id, name: c.contact_person || c.name, company: c.name, email: lower(c.email) }));
  }
  return [...staff, ...customers];
}

// ---------- Checks shared by send and reply ----------
function cleanRecipients({ to = [], cc = [], bcc = [] }) {
  const seen = new Set();
  const out = [];
  for (const [kind, list] of [['to', to], ['cc', cc], ['bcc', bcc]]) {
    for (const r of list) {
      const email = lower(r.email);
      if (!email || seen.has(email)) continue; // the same address only once
      seen.add(email);
      out.push({ kind, email, name: r.name ? String(r.name).slice(0, 150) : null });
    }
  }
  if (!out.some((r) => r.kind === 'to')) throw new AppError(422, 'Add at least one person in To', { to: 'Add at least one address' });
  if (out.length > MAX_RECIPIENTS) throw new AppError(422, `An email can go to at most ${MAX_RECIPIENTS} people`);
  return out;
}

function checkFiles(files = []) {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new AppError(422, 'Attachments can be up to 3 MB in total. Send bigger files as a link instead.', { attachments: 'Over 3 MB' });
  }
  const blocked = files.find((f) => BLOCKED_EXTENSIONS.test(f.originalname));
  if (blocked) throw new AppError(422, `“${blocked.originalname}” can’t be sent by email (program files are blocked).`);
  return files.map((f) => ({ filename: f.originalname, mimeType: f.mimetype, content: f.buffer, size: f.size }));
}

// Linked records must belong to this company — and a customer must be one this person can see
async function checkLinks(auth, { customerId, employeeId, invoiceId }) {
  if (customerId) await getCustomerOrFail(auth, 'customers.view', customerId);
  if (employeeId && !(await employeeModel.findById(auth.orgId, employeeId))) throw new AppError(404, 'Employee not found');
  if (invoiceId) {
    if (!auth.permissions['invoices.manage']) throw new AppError(403, 'You do not have permission to send invoices');
    await invoiceService.getInvoice(auth, invoiceId);
  }
}

// Workard users / customers / employees behind these addresses
async function matchRecipients(orgId, recipients) {
  const emails = [...new Set(recipients.map((r) => r.email))];
  const [users, customers, employees] = await Promise.all([
    sentEmailModel.usersByEmail(orgId, emails),
    sentEmailModel.customersByEmail(orgId, emails),
    sentEmailModel.employeesByEmail(orgId, emails),
  ]);
  const byEmail = (rows) => Object.fromEntries(rows.map((r) => [r.email, r.id]));
  const u = byEmail(users);
  const c = byEmail(customers);
  const e = byEmail(employees);
  return recipients.map((r) => ({ ...r, userId: u[r.email] || null, customerId: c[r.email] || null, employeeId: e[r.email] || null }));
}

// Body + signature, cleaned; and its plain-text twin
function buildBody(html, account) {
  const body = cleanHtml(html);
  if (!body) throw new AppError(422, 'Write a message', { html: 'Write a message' });
  const full = account.signature_html ? `${body}<p></p>${account.signature_html}` : body;
  return { html: full, text: emailPlainText(full) };
}

// Keep a copy of each attachment so the record can show it (Cloudinary; small data: copies locally)
async function storeCopies(orgId, files) {
  const out = [];
  for (const f of files) {
    try {
      const stored = await storeFile({ buffer: f.content, size: f.size, mimetype: f.mimeType, originalname: f.filename }, { orgId, subfolder: 'mail', devMaxKb: 3100 });
      out.push({ fileName: f.filename, mimeType: f.mimeType, size: f.size, url: stored.url, publicId: stored.publicId });
    } catch (err) {
      console.error('Mail attachment copy failed:', err.message);
      out.push({ fileName: f.filename, mimeType: f.mimeType, size: f.size, url: null, publicId: null });
    }
  }
  return out;
}

// The shared send path (new emails, replies, forwards)
async function deliver(auth, account, { recipients, subject, body, files, links, kind = 'new', requestId, threadId, providerCall }) {
  // Double click / retry: the same requestId returns the email already saved
  const existing = await sentEmailModel.findByRequestId(auth.orgId, requestId);
  if (existing) return { ...(await getSent(auth, existing.id)), duplicate: true };

  const matched = await matchRecipients(auth.orgId, recipients);
  const customerId = links.customerId || matched.find((r) => r.customerId)?.customerId || null;
  let emailId;
  try {
    emailId = await withTransaction(async (db) => {
      const id = await sentEmailModel.create(
        auth.orgId,
        {
          senderUserId: auth.userId,
          mailAccountId: account.id,
          provider: account.provider,
          fromEmail: account.email,
          fromName: account.display_name,
          subject,
          bodyHtml: body.html,
          bodyText: body.text.slice(0, 60000),
          customerId,
          employeeId: links.employeeId || null,
          invoiceId: links.invoiceId || null,
          kind,
          threadId,
          requestId,
        },
        db
      );
      await sentEmailModel.addRecipients(id, matched, db);
      return id;
    });
  } catch (err) {
    // Two identical requests at the same moment: the database lets only one in
    if (err.code === 'ER_DUP_ENTRY' && requestId) {
      const first = await sentEmailModel.findByRequestId(auth.orgId, requestId);
      return { ...(await getSent(auth, first.id)), duplicate: true };
    }
    throw err;
  }

  const byKind = (k) => recipients.filter((r) => r.kind === k).map(({ email, name }) => ({ email, name }));
  const message = {
    from: { email: account.email, name: account.display_name },
    to: byKind('to'),
    cc: byKind('cc'),
    bcc: byKind('bcc'),
    subject,
    html: body.html,
    text: body.text,
    attachments: files,
  };
  try {
    const result = await mailAccountService.withProvider(account, (provider, token) => providerCall(provider, token, message));
    await sentEmailModel.markSent(emailId, result);
  } catch (err) {
    await sentEmailModel.markFailed(emailId, err.message);
    throw new AppError(err.status && err.status < 500 ? err.status : 502, `Not sent: ${err.message}`);
  }

  if (files.length) await sentEmailModel.addAttachments(emailId, await storeCopies(auth.orgId, files));
  if (links.invoiceId) await invoiceService.markSentByEmail(auth.orgId, auth.userId, links.invoiceId);
  await auditModel.log({
    orgId: auth.orgId,
    userId: auth.userId,
    action: 'mail.sent',
    entityType: customerId ? 'customer' : null,
    entityId: customerId,
    details: `“${subject.slice(0, 80)}” to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}`, // never the body
  });
  return getSent(auth, emailId);
}

// ---------- Send a new email ----------
export async function send(auth, input, uploaded = []) {
  const account = await mailAccountService.requireAccount(auth);
  const recipients = cleanRecipients(input);
  const files = checkFiles(uploaded);
  const links = { customerId: input.customerId || null, employeeId: input.employeeId || null, invoiceId: input.invoiceId || null };
  await checkLinks(auth, links);
  return deliver(auth, account, {
    recipients,
    subject: input.subject,
    body: buildBody(input.html, account),
    files,
    links,
    requestId: input.requestId,
    providerCall: (provider, token, message) => provider.send(token, message),
  });
}

// ---------- The record ----------
async function attachDetails(auth, rows) {
  const ids = rows.map((r) => r.id);
  const senderByEmail = Object.fromEntries(rows.map((r) => [r.id, r.sender_user_id]));
  const [recipients, attachments] = await Promise.all([
    sentEmailModel.listRecipients(ids, auth.userId, senderByEmail),
    sentEmailModel.listAttachments(ids),
  ]);
  return rows.map((r) => ({
    ...r,
    isMine: Number(r.sender_user_id) === Number(auth.userId),
    recipients: recipients.filter((x) => x.email_id === r.id),
    attachments: attachments.filter((x) => x.email_id === r.id),
  }));
}

export async function listSent(auth, query) {
  const page = query.page || 1;
  const { rows, total } = await sentEmailModel.list(auth.orgId, auth.userId, { ...query, page, pageSize: 25 });
  return { emails: await attachDetails(auth, rows), total, page, pages: Math.max(1, Math.ceil(total / 25)) };
}

export async function getSent(auth, id) {
  const email = await sentEmailModel.findVisible(auth.orgId, id, auth.userId);
  if (!email) throw new AppError(404, 'Email not found');
  const [withDetails] = await attachDetails(auth, [email]);
  return withDetails;
}

// ---------- Templates ----------
export const listTemplates = (auth) => emailTemplateModel.listVisible(auth.orgId, auth.userId);

async function getOwnTemplate(auth, id) {
  const template = await emailTemplateModel.findVisible(auth.orgId, id, auth.userId);
  if (!template) throw new AppError(404, 'Template not found');
  if (Number(template.created_by) !== Number(auth.userId)) throw new AppError(403, 'Only the person who made this template can change it');
  return template;
}

export async function createTemplate(auth, data) {
  const id = await emailTemplateModel.create(auth.orgId, auth.userId, { ...data, bodyHtml: cleanHtml(data.bodyHtml) });
  return emailTemplateModel.findVisible(auth.orgId, id, auth.userId);
}

export async function updateTemplate(auth, id, data) {
  await getOwnTemplate(auth, id);
  await emailTemplateModel.update(auth.orgId, id, { ...data, bodyHtml: cleanHtml(data.bodyHtml) });
  return emailTemplateModel.findVisible(auth.orgId, id, auth.userId);
}

export async function deleteTemplate(auth, id) {
  await getOwnTemplate(auth, id);
  await emailTemplateModel.remove(auth.orgId, id);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Fill the gaps — {customer name}, {invoice number}, {amount due}… — for a customer / invoice / employee
export async function fillTemplate(auth, id, { customerId, invoiceId, employeeId }) {
  const template = await emailTemplateModel.findVisible(auth.orgId, id, auth.userId);
  if (!template) throw new AppError(404, 'Template not found');
  const org = await organizationModel.findById(auth.orgId);
  const values = { 'company name': org.name, 'my name': auth.userName || '' };
  if (invoiceId && auth.permissions['invoices.view']) {
    const invoice = await invoiceService.getInvoice(auth, invoiceId);
    customerId = customerId || invoice.customer_id;
    Object.assign(values, {
      'invoice number': invoice.invoice_number,
      'amount due': formatNaira(invoice.total_kobo - invoice.amount_paid_kobo),
      'due date': formatDateLong(invoice.due_date),
      'invoice link': invoice.public_token ? `${env.clientUrls[0]}/i/${invoice.public_token}` : '',
    });
  }
  if (customerId) {
    const customer = await getCustomerOrFail(auth, 'customers.view', customerId);
    Object.assign(values, { 'customer name': customer.name, 'contact name': customer.contact_person || customer.name });
  }
  if (employeeId) {
    const employee = await employeeModel.findById(auth.orgId, employeeId);
    if (employee) values['employee name'] = `${employee.first_name} ${employee.last_name}`;
  }
  // Unknown or unavailable gaps are left as written, so the person sees what still needs filling
  const fill = (text, html) => text.replace(/\{([a-z ]+)\}/gi, (whole, key) => (key.toLowerCase() in values ? (html ? esc(values[key.toLowerCase()]) : values[key.toLowerCase()]) : whole));
  return { subject: fill(template.subject, false), html: fill(template.body_html, true) };
}

// ---------- The inbox (live) ----------
async function requireInbox(auth) {
  const account = await mailAccountService.requireAccount(auth);
  if (!mailAccountService.inboxAllowed(account)) {
    throw new AppError(403, 'Reading this mailbox inside Workard isn’t available yet. You can still send from it.');
  }
  return account;
}

// "Customer: Zenith Foods" chips for senders who are customers this person can see
async function customerChips(auth, emails) {
  const scope = auth.permissions['customers.view'];
  if (!scope || !emails.length) return {};
  const rows = await sentEmailModel.customersByEmail(auth.orgId, [...new Set(emails)]);
  const chips = {};
  for (const row of rows) {
    const visible = await customerModel.findInScope(auth.orgId, row.id, scopeCondition(scope, auth.employee));
    if (visible) chips[row.email] = { id: row.id, name: row.name };
  }
  return chips;
}

export async function listInbox(auth, { search, pageToken }) {
  const account = await requireInbox(auth);
  const result = await mailAccountService.withProvider(account, (provider, token) => provider.listThreads(token, { search, pageToken }));
  const chips = await customerChips(auth, result.threads.map((t) => t.from?.email).filter(Boolean));
  return { ...result, threads: result.threads.map((t) => ({ ...t, customer: chips[t.from?.email] || null })), me: account.email };
}

export async function getThread(auth, threadId) {
  const account = await requireInbox(auth);
  const thread = await mailAccountService.withProvider(account, (provider, token) => provider.getThread(token, threadId));
  if (!thread.messages.length) throw new AppError(404, 'Conversation not found');
  const chips = await customerChips(auth, thread.messages.map((m) => m.from?.email).filter(Boolean));
  return {
    ...thread,
    me: account.email,
    messages: thread.messages.map((m) => ({
      ...m,
      html: m.html ? cleanEmailHtml(m.html) : '',
      customer: chips[m.from?.email] || null,
      messageIdHeader: undefined, // internal (threading only)
      references: undefined,
    })),
  };
}

export async function getAttachment(auth, messageId, attachmentId) {
  const account = await requireInbox(auth);
  return mailAccountService.withProvider(account, (provider, token) => provider.getAttachment(token, messageId, attachmentId));
}

export async function markRead(auth, threadId) {
  const account = await requireInbox(auth);
  await mailAccountService.withProvider(account, (provider, token) => provider.markRead(token, threadId));
  return { ok: true };
}

// Reply / reply all / forward from the inbox. Goes through the same send path, so it is recorded.
// Forward also carries the original's attachments when they fit in the 3 MB limit.
export async function reply(auth, threadId, messageId, input, uploaded = []) {
  const account = await requireInbox(auth);
  const thread = await mailAccountService.withProvider(account, (provider, token) => provider.getThread(token, threadId));
  const original = thread.messages.find((m) => m.id === messageId);
  if (!original) throw new AppError(404, 'Message not found in this conversation');

  const recipients = cleanRecipients(input);
  let files = checkFiles(uploaded);
  let skipped = [];
  if (input.mode === 'forward' && account.provider === 'google' && original.attachments.length) {
    // (Outlook's createForward keeps the original attachments itself)
    let room = MAX_ATTACHMENT_BYTES - files.reduce((s, f) => s + f.size, 0);
    for (const att of original.attachments) {
      if (att.size > room) {
        skipped.push(att.name);
        continue;
      }
      const { content } = await mailAccountService.withProvider(account, (provider, token) => provider.getAttachment(token, messageId, att.id));
      files.push({ filename: att.name, mimeType: att.mimeType, content, size: content.length });
      room -= content.length;
    }
  }
  const body = buildBody(input.html, account);
  if (skipped.length) body.html += `<p><em>Not attached (over 3 MB): ${skipped.map(esc).join(', ')}</em></p>`;
  const base = original.subject || thread.subject || '';
  const subject = input.subject || (input.mode === 'forward' ? (/^fwd?:/i.test(base) ? base : `Fwd: ${base}`) : /^re:/i.test(base) ? base : `Re: ${base}`);

  return deliver(auth, account, {
    recipients,
    subject,
    body,
    files,
    links: { customerId: input.customerId || null },
    kind: input.mode,
    requestId: input.requestId,
    threadId,
    providerCall: (provider, token, message) => provider.reply(token, { ...message, threadId, messageId, mode: input.mode, original }),
  });
}

// ---------- A big file as a link ----------
// Over 3 MB? Upload it to Workard (Cloudinary) and put the link in the email instead.
export async function uploadLink(auth, file) {
  if (!file) throw new AppError(422, 'Choose a file');
  const stored = await storeFile(file, { orgId: auth.orgId, subfolder: 'mail-links', devMaxKb: 300 });
  return { url: stored.url, name: file.originalname, size: file.size };
}
