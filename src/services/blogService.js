import * as blogModel from '../models/blogModel.js';
import * as adminModel from '../models/adminModel.js';
import { cleanBlogHtml, htmlToText } from '../utils/cleanHtml.js';
import { storeFile } from './uploadService.js';
import { requestRebuild } from './deployHookService.js';
import AppError from '../utils/AppError.js';

// ============================================================
// BLOG — written by Workard super admins, shown on the website (/blog).
//   draft      only admins see it
//   published  live from published_at (a future date = scheduled)
// Publishing, changing or removing a live post asks Vercel to rebuild the website
// (deployHookService) so the post is prerendered for Google and link previews.
// No comments (for now).
// ============================================================

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'post';
}

async function uniqueSlug(wanted, exceptId = 0) {
  const base = slugify(wanted);
  let slug = base;
  for (let n = 2; await blogModel.slugTaken(slug, exceptId); n += 1) slug = `${base}-${n}`;
  return slug;
}

const isLive = (p) => p && p.status === 'published' && p.published_at && new Date(String(p.published_at).replace(' ', 'T')) <= new Date();
const wordCount = (html) => htmlToText(html).split(/\s+/).filter(Boolean).length;
export const readingMinutes = (html) => Math.max(1, Math.round(wordCount(html) / 200));

function excerptOf(data) {
  if (data.excerpt) return data.excerpt;
  const text = htmlToText(data.bodyHtml);
  return text.length > 220 ? `${text.slice(0, 217).replace(/\s+\S*$/, '')}…` : text;
}

// ---------- Admin ----------
export const listPosts = ({ search }) => blogModel.listAll({ search });

export async function getPost(id) {
  const post = await blogModel.findById(id);
  if (!post) throw new AppError(404, 'Post not found');
  return { ...post, live: isLive(post), readingMinutes: readingMinutes(post.body_html) };
}

export async function createPost(admin, data) {
  const bodyHtml = cleanBlogHtml(data.bodyHtml);
  if (!htmlToText(bodyHtml)) throw new AppError(422, 'Write the post first', { bodyHtml: 'Write something' });
  const publishedAt = data.status === 'published' ? data.publishedAt || new Date() : data.publishedAt || null;
  const id = await blogModel.create({
    ...data,
    slug: await uniqueSlug(data.slug || data.title),
    bodyHtml,
    excerpt: excerptOf({ ...data, bodyHtml }),
    publishedAt,
    authorUserId: admin.userId,
  });
  await adminModel.log(admin.userId, data.status === 'published' ? 'post.published' : 'post.drafted', { targetType: 'post', targetId: id, details: data.title });
  if (data.status === 'published') requestRebuild('blog post published');
  return getPost(id);
}

export async function updatePost(admin, id, data) {
  const before = await getPost(id);
  const fields = {};
  if (data.title !== undefined) fields.title = data.title;
  if (data.slug !== undefined && data.slug !== before.slug) fields.slug = await uniqueSlug(data.slug || data.title || before.title, id);
  if (data.bodyHtml !== undefined) {
    fields.body_html = cleanBlogHtml(data.bodyHtml);
    if (!htmlToText(fields.body_html)) throw new AppError(422, 'Write the post first', { bodyHtml: 'Write something' });
  }
  if (data.excerpt !== undefined) fields.excerpt = data.excerpt || excerptOf({ bodyHtml: fields.body_html ?? before.body_html });
  if (data.coverUrl !== undefined) fields.cover_url = data.coverUrl || null;
  if (data.category !== undefined) fields.category = data.category || null;
  if (data.seoTitle !== undefined) fields.seo_title = data.seoTitle || null;
  if (data.seoDescription !== undefined) fields.seo_description = data.seoDescription || null;
  if (data.status !== undefined) fields.status = data.status;
  if (data.publishedAt !== undefined) fields.published_at = data.publishedAt || null;
  // Publishing for the first time with no date = now
  if ((fields.status ?? before.status) === 'published' && !(fields.published_at ?? before.published_at)) fields.published_at = new Date();
  await blogModel.update(id, fields);

  const after = await getPost(id);
  const action = before.status !== after.status ? (after.status === 'published' ? 'post.published' : 'post.unpublished') : 'post.updated';
  await adminModel.log(admin.userId, action, { targetType: 'post', targetId: id, details: after.title });
  if (before.live || after.status === 'published') requestRebuild('blog post changed');
  return after;
}

export async function deletePost(admin, id) {
  const post = await getPost(id);
  await blogModel.remove(id);
  await adminModel.log(admin.userId, 'post.deleted', { details: post.title });
  if (post.live) requestRebuild('blog post removed');
}

// Images inside a post, and cover images
export async function uploadImage(admin, file) {
  const stored = await storeFile(file, { orgId: 'platform', subfolder: 'blog', devMaxKb: 400 });
  return { url: stored.url };
}

// ---------- Website (no login) ----------
export async function listLive({ category, page = 1, pageSize = 12 }) {
  const { rows, total } = await blogModel.listLive({ category, limit: pageSize, offset: (page - 1) * pageSize });
  return { posts: rows, total, page, pages: Math.max(1, Math.ceil(total / pageSize)), categories: await blogModel.categories() };
}

export async function getLive(slug) {
  const post = await blogModel.findLiveBySlug(slug);
  if (!post) throw new AppError(404, 'Post not found');
  const { rows } = await blogModel.listLive({ category: post.category || undefined, limit: 4 });
  return {
    post: {
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      bodyHtml: post.body_html,
      coverUrl: post.cover_url,
      category: post.category,
      seoTitle: post.seo_title,
      seoDescription: post.seo_description,
      publishedAt: post.published_at,
      updatedAt: post.updated_at,
      authorName: post.author_name,
      readingMinutes: readingMinutes(post.body_html),
    },
    related: rows.filter((r) => r.id !== post.id).slice(0, 3),
  };
}

// Every live post, for the website build (prerender + sitemap)
export async function allLiveForBuild() {
  const { rows } = await blogModel.listLive({ limit: 1000 });
  return Promise.all(rows.map((r) => getLive(r.slug)));
}
