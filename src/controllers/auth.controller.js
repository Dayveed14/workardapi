import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import {
  REFRESH_COOKIE,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  setAuthCookies,
  clearAuthCookies,
} from '../utils/tokens.js';

const SALT_ROUNDS = 12;
// Used to keep login timing similar whether or not the email exists
const DUMMY_HASH = bcrypt.hashSync('workard-timing-guard', SALT_ROUNDS);

async function loadSession(userId, db = pool) {
  const [rows] = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.email_verified,
            b.id AS business_id, b.name AS business_name, b.plan, m.role
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
       JOIN businesses b  ON b.id = m.business_id
      WHERE u.id = ?
      ORDER BY m.id
      LIMIT 1`,
    [userId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    user: {
      id: r.id,
      fullName: r.full_name,
      email: r.email,
      phone: r.phone,
      emailVerified: !!r.email_verified,
    },
    business: { id: r.business_id, name: r.business_name, plan: r.plan },
    role: r.role,
  };
}

async function issueTokens(req, res, session, db = pool) {
  const accessToken = signAccessToken({
    sub: String(session.user.id),
    bid: session.business.id,
    role: session.role,
  });
  const refreshToken = signRefreshToken(session.user.id);
  const expires = new Date(Date.now() + env.jwt.refreshDays * 86400000);

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      session.user.id,
      hashToken(refreshToken),
      (req.get('user-agent') || '').slice(0, 255),
      req.ip,
      expires,
    ]
  );
  setAuthCookies(res, accessToken, refreshToken);
}

// POST /api/auth/register
export async function register(req, res, next) {
  try {
    const { fullName, businessName, email, phone, password } = req.body;

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(409).json({
        message: 'An account with this email already exists',
        errors: { email: 'This email is already registered' },
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const session = await withTransaction(async (conn) => {
      const [u] = await conn.query(
        'INSERT INTO users (full_name, email, phone, password_hash, last_login_at) VALUES (?, ?, ?, ?, NOW())',
        [fullName, email, phone || null, passwordHash]
      );
      const [b] = await conn.query('INSERT INTO businesses (name) VALUES (?)', [businessName]);
      await conn.query(
        "INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, 'owner')",
        [u.insertId, b.insertId]
      );
      const s = await loadSession(u.insertId, conn);
      await issueTokens(req, res, s, conn);
      return s;
    });

    res.status(201).json(session);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'An account with this email already exists',
        errors: { email: 'This email is already registered' },
      });
    }
    next(err);
  }
}

// POST /api/auth/login
export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT id, password_hash FROM users WHERE email = ?', [email]);
    const user = rows[0];

    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ message: 'Incorrect email or password' });
    }

    const session = await loadSession(user.id);
    if (!session) return res.status(403).json({ message: 'This account has no active business' });

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await issueTokens(req, res, session);
    res.json(session);
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/refresh — rotates the refresh token
export async function refresh(req, res, next) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ message: 'Not authenticated' });

  try {
    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Session expired' });
    }

    const hash = hashToken(token);
    const [rows] = await pool.query(
      'SELECT id, user_id, revoked_at FROM refresh_tokens WHERE token_hash = ? AND expires_at > NOW()',
      [hash]
    );
    const stored = rows[0];

    if (!stored || stored.revoked_at) {
      // Reuse of a revoked token = possible theft: revoke every session for this user
      if (stored) {
        await pool.query(
          'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
          [stored.user_id]
        );
      }
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Session expired' });
    }

    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [stored.id]);
    const session = await loadSession(Number(payload.sub));
    if (!session) {
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Session expired' });
    }
    await issueTokens(req, res, session);
    res.json(session);
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/logout
export async function logout(req, res, next) {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?', [
        hashToken(token),
      ]);
    }
    clearAuthCookies(res);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me
export async function me(req, res, next) {
  try {
    const session = await loadSession(req.user.id);
    if (!session) return res.status(401).json({ message: 'Not authenticated' });
    res.json(session);
  } catch (err) {
    next(err);
  }
}
