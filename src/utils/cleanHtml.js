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
    },
  }).trim();
}

// Plain text (for search snippets and notifications)
export const htmlToText = (html) => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
