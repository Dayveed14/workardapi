import { pool } from '../config/db.js';

// ============================================================
// Connected mailboxes (mail_accounts) and the one-time "Connect" slips (mail_oauth_states).
// Tokens arrive here already encrypted — this file never sees a plain token.
// ============================================================

const PUBLIC_COLUMNS = `id, organization_id, user_id, provider, email, display_name, scopes, is_workspace, can_read,
  signature_html, status, last_error, connected_at, access_expires_at`;

export async function findForUser(orgId, userId, db = pool) {
  const [rows] = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM mail_accounts WHERE organization_id = ? AND user_id = ?`, [orgId, userId]);
  return rows[0] || null;
}

// With the encrypted tokens — only the mail services use this
export async function findWithTokens(orgId, userId, db = pool) {
  const [rows] = await db.query('SELECT * FROM mail_accounts WHERE organization_id = ? AND user_id = ?', [orgId, userId]);
  return rows[0] || null;
}

// Connect (or reconnect, replacing the old connection)
export async function save(orgId, userId, a, db = pool) {
  await db.query(
    `INSERT INTO mail_accounts
       (organization_id, user_id, provider, email, display_name, refresh_token_enc, access_token_enc, access_expires_at,
        scopes, is_workspace, can_read, status, last_error, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider), email = VALUES(email), display_name = VALUES(display_name),
       refresh_token_enc = VALUES(refresh_token_enc), access_token_enc = VALUES(access_token_enc),
       access_expires_at = VALUES(access_expires_at), scopes = VALUES(scopes), is_workspace = VALUES(is_workspace),
       can_read = VALUES(can_read), status = 'active', last_error = NULL, connected_at = VALUES(connected_at)`,
    [orgId, userId, a.provider, a.email, a.displayName || null, a.refreshTokenEnc, a.accessTokenEnc, a.accessExpiresAt,
     a.scopes || null, a.isWorkspace ? 1 : 0, a.canRead ? 1 : 0, new Date()]
  );
}

export async function updateTokens(id, { accessTokenEnc, accessExpiresAt, refreshTokenEnc }, db = pool) {
  await db.query(
    `UPDATE mail_accounts SET access_token_enc = ?, access_expires_at = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
       status = 'active', last_error = NULL WHERE id = ?`,
    [accessTokenEnc, accessExpiresAt, refreshTokenEnc || null, id]
  );
}

export async function markNeedsReconnect(id, reason, db = pool) {
  await db.query("UPDATE mail_accounts SET status = 'needs_reconnect', last_error = ?, access_token_enc = NULL WHERE id = ?", [
    String(reason || '').slice(0, 250),
    id,
  ]);
}

export async function setSignature(orgId, userId, html, db = pool) {
  await db.query('UPDATE mail_accounts SET signature_html = ? WHERE organization_id = ? AND user_id = ?', [html || null, orgId, userId]);
}

export async function remove(orgId, userId, db = pool) {
  await db.query('DELETE FROM mail_accounts WHERE organization_id = ? AND user_id = ?', [orgId, userId]);
}

// ---------- The one-time Connect slips ----------
export async function createState(s, db = pool) {
  await db.query(
    `INSERT INTO mail_oauth_states (state_hash, organization_id, user_id, provider, code_verifier, with_inbox, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.stateHash, s.orgId, s.userId, s.provider, s.codeVerifier, s.withInbox ? 1 : 0, s.expiresAt]
  );
}

// Takes a slip: only once, only before it expires. Returns null otherwise.
export async function takeState(stateHash, provider, db = pool) {
  const [result] = await db.query(
    'UPDATE mail_oauth_states SET used_at = ? WHERE state_hash = ? AND provider = ? AND used_at IS NULL AND expires_at > ?',
    [new Date(), stateHash, provider, new Date()]
  );
  if (!result.affectedRows) return null;
  const [rows] = await db.query('SELECT * FROM mail_oauth_states WHERE state_hash = ?', [stateHash]);
  return rows[0];
}

export async function cleanOldStates(db = pool) {
  await db.query('DELETE FROM mail_oauth_states WHERE expires_at < ?', [new Date(Date.now() - 24 * 3600_000)]);
}
