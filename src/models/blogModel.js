import { pool } from '../config/db.js';

const SELECT = `SELECT p.*, u.full_name AS author_name FROM blog_posts p JOIN users u ON u.id = p.author_user_id`;
// Live on the website: published, and its publish time has come
const LIVE = "p.status = 'published' AND p.published_at <= NOW()";

export async function listAll({ search } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT p.id, p.slug, p.title, p.excerpt, p.cover_url, p.category, p.status, p.published_at, p.updated_at, p.created_at, u.full_name AS author_name
       FROM blog_posts p JOIN users u ON u.id = p.author_user_id
      ${search ? 'WHERE p.title LIKE ? OR p.category LIKE ?' : ''}
      ORDER BY COALESCE(p.published_at, p.created_at) DESC`,
    search ? [`%${search}%`, `%${search}%`] : []
  );
  return rows;
}

export async function listLive({ category, limit = 12, offset = 0 } = {}, db = pool) {
  const where = [LIVE];
  const params = [];
  if (category) { where.push('p.category = ?'); params.push(category); }
  const [rows] = await db.query(
    `SELECT p.id, p.slug, p.title, p.excerpt, p.cover_url, p.category, p.published_at, u.full_name AS author_name
       FROM blog_posts p JOIN users u ON u.id = p.author_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.published_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM blog_posts p WHERE ${where.join(' AND ')}`, params);
  return { rows, total: Number(total) };
}

export async function categories(db = pool) {
  const [rows] = await db.query(`SELECT p.category, COUNT(*) AS n FROM blog_posts p WHERE ${LIVE} AND p.category IS NOT NULL GROUP BY p.category ORDER BY p.category`);
  return rows.map((r) => ({ name: r.category, count: Number(r.n) }));
}

export async function findLiveBySlug(slug, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE p.slug = ? AND ${LIVE}`, [slug]);
  return rows[0] || null;
}

export async function findById(id, db = pool) {
  const [rows] = await db.query(`${SELECT} WHERE p.id = ?`, [id]);
  return rows[0] || null;
}

export async function slugTaken(slug, exceptId = 0, db = pool) {
  const [rows] = await db.query('SELECT 1 FROM blog_posts WHERE slug = ? AND id <> ?', [slug, exceptId]);
  return rows.length > 0;
}

export async function create(d, db = pool) {
  const [r] = await db.query(
    `INSERT INTO blog_posts (slug, title, excerpt, body_html, cover_url, category, seo_title, seo_description, status, published_at, author_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.slug, d.title, d.excerpt || null, d.bodyHtml, d.coverUrl || null, d.category || null, d.seoTitle || null, d.seoDescription || null, d.status, d.publishedAt || null, d.authorUserId]
  );
  return r.insertId;
}

export async function update(id, fields, db = pool) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.query(`UPDATE blog_posts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), id]);
}

export async function remove(id, db = pool) {
  await db.query('DELETE FROM blog_posts WHERE id = ?', [id]);
}

// Posts whose scheduled time arrived since `since` (the daily job rebuilds the website for them)
export async function wentLiveSince(since, db = pool) {
  const [[row]] = await db.query("SELECT COUNT(*) AS n FROM blog_posts WHERE status = 'published' AND published_at > ? AND published_at <= NOW()", [since]);
  return Number(row.n);
}
