import { Resend } from 'resend';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

const resend = env.resend.apiKey ? new Resend(env.resend.apiKey) : null;

// In development without Resend, emails are kept here (the smoke test reads codes from it)
export const devOutbox = [];

// Sends an email through Resend.
// In development without RESEND_API_KEY, the email is printed to the console instead
// so you can still copy the code and test.
export async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    if (env.isProd) throw new AppError(500, 'Email is not configured');
    console.log(`\n📧 [DEV EMAIL] To: ${to}\n   Subject: ${subject}\n   ${text}\n`);
    devOutbox.push({ to, subject, text });
    return;
  }

  const { error } = await resend.emails.send({ from: env.resend.from, to, subject, html, text });
  if (error) {
    console.error('Resend error:', error);
    throw new AppError(502, 'We could not send the email. Please try again.');
  }
}

// ---------- Templates ----------
// Names typed by users go into HTML, so escape them (stops HTML/script injection in emails)
const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(content) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:32px 16px">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <div style="background:#0f172a;padding:20px 28px">
        <span style="color:#ffffff;font-size:20px;font-weight:bold">Work<span style="color:#10b981">ard</span></span>
      </div>
      <div style="padding:28px;color:#0f172a;font-size:15px;line-height:1.6">${content}</div>
    </div>
    <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px">Run Your Business. Grow Smarter.</p>
  </div>`;
}

const PURPOSE_TEXT = {
  signup: { subject: 'Verify your Workard account', intro: 'Use this code to verify your email and finish creating your account.' },
  login: { subject: 'Your Workard login code', intro: 'Use this code to finish logging in.' },
  reset: { subject: 'Reset your Workard password', intro: 'Use this code to reset your password.' },
};

export function otpEmail(code, purpose) {
  const { subject, intro } = PURPOSE_TEXT[purpose];
  return {
    subject,
    text: `${intro} Your code is ${code}. It expires in 10 minutes.`,
    html: layout(`
      <p>${intro}</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:24px 0;color:#2563eb">${code}</p>
      <p style="color:#64748b">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>`),
  };
}

export function inviteEmail({ organizationName, firstName, link }) {
  return {
    subject: `You've been invited to join ${organizationName} on Workard`,
    text: `Hi ${firstName}, ${organizationName} has invited you to Workard. Accept here: ${link} (expires in 7 days)`,
    html: layout(`
      <p>Hi ${esc(firstName)},</p>
      <p><strong>${esc(organizationName)}</strong> has invited you to Workard — where you'll clock in, request leave and see your records.</p>
      <p style="margin:28px 0">
        <a href="${link}" style="background:#2563eb;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Accept invitation</a>
      </p>
      <p style="color:#64748b">This link expires in 7 days.</p>`),
  };
}

export function invoiceEmail({ businessName, customerName, invoiceNumber, amount, dueDate, link }) {
  return {
    subject: `Invoice ${invoiceNumber} from ${businessName}`,
    text: `Hello ${customerName}, ${businessName} has sent you invoice ${invoiceNumber} for ${amount}, due ${dueDate}. View it here: ${link}`,
    html: layout(`
      <p>Hello ${esc(customerName)},</p>
      <p><strong>${esc(businessName)}</strong> has sent you invoice <strong>${esc(invoiceNumber)}</strong>.</p>
      <table style="width:100%;margin:20px 0;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#64748b">Amount due</td><td style="padding:8px 0;text-align:right;font-size:20px;font-weight:bold">${amount}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Due date</td><td style="padding:8px 0;text-align:right">${dueDate}</td></tr>
      </table>
      <p style="margin:28px 0">
        <a href="${link}" style="background:#2563eb;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">View invoice</a>
      </p>
      <p style="color:#64748b">Payment details are on the invoice.</p>`),
  };
}

export function payslipEmail({ firstName, businessName, period, link }) {
  const [y, m] = period.split('-').map(Number);
  const month = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return {
    subject: `Your ${month} payslip from ${businessName}`,
    text: `Hi ${firstName}, your payslip for ${month} is ready. View it here: ${link}`,
    html: layout(`
      <p>Hi ${esc(firstName)},</p>
      <p>Your payslip for <strong>${month}</strong> from <strong>${esc(businessName)}</strong> is ready.</p>
      <p style="margin:28px 0">
        <a href="${link}" style="background:#2563eb;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">View payslip</a>
      </p>
      <p style="color:#64748b">For your privacy, the amounts are only shown after you log in.</p>`),
  };
}

const button = (link, label) =>
  `<p style="margin:28px 0"><a href="${link}" style="background:#2563eb;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${label}</a></p>`;

const PRIORITY_TEXT = { urgent: 'Urgent', high: 'High priority', normal: '', low: '' };

export function taskAssignedEmail({ firstName, assignedBy, title, dueDate, priority, link }) {
  const due = dueDate ? ` — due ${dueDate}` : '';
  const tag = PRIORITY_TEXT[priority] ? ` (${PRIORITY_TEXT[priority]})` : '';
  return {
    subject: `New task: ${title}${tag}`,
    text: `Hi ${firstName}, ${assignedBy} gave you a task: "${title}"${due}. Open it here: ${link}`,
    html: layout(`
      <p>Hi ${esc(firstName)},</p>
      <p><strong>${esc(assignedBy)}</strong> gave you a task${esc(tag)}:</p>
      <p style="font-size:17px;font-weight:bold;margin:16px 0">${esc(title)}</p>
      ${dueDate ? `<p style="color:#64748b">Due ${esc(dueDate)}</p>` : ''}
      ${button(link, 'Open task')}`),
  };
}

// One morning email per person: what's due today and what's late
export function taskDigestEmail({ firstName, businessName, dueToday, overdue, link }) {
  const list = (tasks) =>
    `<ul style="padding-left:18px;margin:8px 0 16px">${tasks.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ul>`;
  const parts = [];
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  return {
    subject: `Your tasks today: ${parts.join(', ')}`,
    text: `Hi ${firstName}, you have ${parts.join(' and ')} at ${businessName}. ${[...overdue, ...dueToday].map((t) => `- ${t.title}`).join(' ')} See them: ${link}`,
    html: layout(`
      <p>Good morning ${esc(firstName)},</p>
      ${overdue.length ? `<p style="margin-bottom:0;color:#dc2626"><strong>Overdue</strong></p>${list(overdue)}` : ''}
      ${dueToday.length ? `<p style="margin-bottom:0"><strong>Due today</strong></p>${list(dueToday)}` : ''}
      ${button(link, 'Open my tasks')}
      <p style="color:#64748b">${esc(businessName)} · sent by Workard every working morning.</p>`),
  };
}

export function reviewEmail({ firstName, businessName, period, stage, link }) {
  const TEXT = {
    self_review: { subject: `Your ${period} review: please rate yourself`, body: 'Your performance review has started. Please rate yourself first.' },
    acknowledgement: { subject: `Your ${period} review is ready`, body: 'Your manager has finished your performance review. Please read it and confirm.' },
  };
  const t = TEXT[stage];
  return {
    subject: t.subject,
    text: `Hi ${firstName}, ${t.body} (${businessName}) ${link}`,
    html: layout(`
      <p>Hi ${esc(firstName)},</p>
      <p>${t.body}</p>
      ${button(link, 'Open review')}
      <p style="color:#64748b">${esc(businessName)}</p>`),
  };
}
