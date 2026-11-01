import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// ---------- Access token (15 min) — proves who you are on every request ----------
export function signAccessToken({ userId, orgId }) {
  return jwt.sign({ sub: String(userId), oid: orgId, typ: 'access' }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires,
  });
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.jwt.accessSecret);
  if (payload.typ !== 'access') throw new Error('Wrong token type');
  return payload;
}

// ---------- Refresh token (7 days) — gets a new access token without logging in ----------
export function signRefreshToken(userId) {
  // jti makes each token unique even if two are issued in the same second
  return jwt.sign({ sub: String(userId), jti: crypto.randomUUID() }, env.jwt.refreshSecret, {
    expiresIn: `${env.jwt.refreshDays}d`,
  });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

// ---------- Challenge token (10 min) — links the "enter your code" step to the right user ----------
// It is NOT a login: it only says "user X is in the middle of verifying for purpose Y".
export function signChallengeToken({ userId, purpose }) {
  return jwt.sign({ sub: String(userId), purpose, typ: 'challenge' }, env.jwt.accessSecret, { expiresIn: '10m' });
}

export function verifyChallengeToken(token, allowedPurposes) {
  try {
    const payload = jwt.verify(token, env.jwt.accessSecret);
    if (payload.typ !== 'challenge' || !allowedPurposes.includes(payload.purpose)) return null;
    return { userId: Number(payload.sub), purpose: payload.purpose };
  } catch {
    return null;
  }
}

// Tokens and codes are stored as SHA-256 hashes, never as plain text
export function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
