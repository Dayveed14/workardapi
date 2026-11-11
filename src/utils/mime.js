import crypto from 'node:crypto';

// ============================================================
// Builds a standard email (MIME) as text. Gmail's API wants the whole email in this form
// (base64url-encoded); Microsoft takes JSON instead, so only googleMail.js uses this.
//
//   multipart/mixed
//    ├─ multipart/alternative
//    │   ├─ text/plain   (for old mail apps)
//    │   └─ text/html
//    └─ attachments (base64)
// ============================================================

// Header text in any language: "=?UTF-8?B?...?=" when it isn't plain ASCII
export function encodeHeader(text) {
  const value = String(text || '').replace(/[\r\n]+/g, ' '); // never allow a line break into a header
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// "Ada Okafor" <ada@x.com>
export function formatAddress({ email, name }) {
  const address = String(email).replace(/[\r\n<>]/g, '');
  if (!name) return address;
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${String(name).replace(/["\\\r\n]/g, '')}"` : encodeHeader(name);
  return `${display} <${address}>`;
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

export function buildMime({ from, to = [], cc = [], bcc = [], subject, html, text, attachments = [], inReplyTo, references }) {
  const mixed = `mixed_${crypto.randomBytes(12).toString('hex')}`;
  const alt = `alt_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${formatAddress(from)}`,
    to.length && `To: ${to.map(formatAddress).join(', ')}`,
    cc.length && `Cc: ${cc.map(formatAddress).join(', ')}`,
    bcc.length && `Bcc: ${bcc.map(formatAddress).join(', ')}`, // Gmail delivers to Bcc and removes the header
    `Subject: ${encodeHeader(subject)}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`,
    references && `References: ${references}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text || '', 'utf8').toString('base64')),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html || '', 'utf8').toString('base64')),
    `--${alt}--`,
  ].filter((l) => l !== false && l !== undefined && l !== null && l !== 0);

  for (const file of attachments) {
    const safeName = String(file.filename).replace(/["\r\n]/g, '');
    lines.push(
      `--${mixed}`,
      `Content-Type: ${file.mimeType || 'application/octet-stream'}; name="${encodeHeader(safeName)}"`,
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(file.content.toString('base64'))
    );
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}

// Gmail wants base64url (no + / =)
export const toBase64Url = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64Url = (data) => Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
