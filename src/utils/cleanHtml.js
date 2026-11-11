import sanitizeHtml from 'sanitize-html';

// Documents written in Workard are stored as HTML. Only simple formatting is kept —
// no scripts, styles, images or event handlers — so a document can never run code
// in someone else's browser.
export function cleanHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      b: 'strong',
      i: 'em',
      div: 'p', // the editor makes a <div> per line in some browsers — keep them as paragraphs
    },
  }).trim();
}

// Plain text (for search snippets and notifications)
// (block ends become spaces, so "<h2>PAYE</h2><p>Hello</p>" reads "PAYE Hello")
export const htmlToText = (html) =>
  sanitizeHtml(String(html || '').replace(/<\/(p|h[1-6]|li|blockquote|div)>|<br\s*\/?>/gi, ' '), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();

// Blog posts (written by Workard super admins) may also have images and a third heading level.
// Images must be web addresses (or data: images while developing without Cloudinary).
export function cleanBlogHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr', 'img', 'figure', 'figcaption'],
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'http', 'data'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      b: 'strong',
      i: 'em',
      div: 'p',
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && /^data:/i.test(frame.attribs.src || '') && !/^data:image\/(png|jpe?g|gif|webp);/i.test(frame.attribs.src),
  }).trim();
}

// RECEIVED emails (Mail → Inbox). Emails use tables and inline styles for their layout, so far
// more is kept than above — but never scripts, forms, iframes or event handlers. The browser
// also shows them inside a locked-down frame (no scripts, remote images off until asked).
export function cleanEmailHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p', 'br', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sup', 'sub',
      'ul', 'ol', 'li', 'blockquote', 'a', 'hr', 'img', 'pre', 'code', 'font', 'center',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir'],
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      table: ['border', 'cellpadding', 'cellspacing'],
      font: ['face', 'size', 'color'],
    },
    parseStyleAttributes: false, // keep inline styles as written (they can't run code)
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'http', 'data', 'cid'] },
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  });
}

// HTML → readable plain text for the text/plain part of an email (keeps line breaks)
export function emailPlainText(html) {
  return sanitizeHtml(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|blockquote|div|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• '),
    { allowedTags: [], allowedAttributes: {} }
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
