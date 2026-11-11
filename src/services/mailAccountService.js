import crypto from 'node:crypto';
import * as mailAccountModel from '../models/mailAccountModel.js';
import * as auditModel from '../models/auditModel.js';
import { getProvider, PROVIDER_NAMES } from './mailProviders/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { hashToken } from './tokenService.js';
import { cleanHtml } from '../utils/cleanHtml.js';
import { env } from '../config/env.js';
import AppError from '../utils/AppError.js';

// ============================================================
// MAIL ACCOUNTS — connecting a person's own Gmail / Outlook (OAuth), keeping its tokens
// fresh, and disconnecting.
//
// Connecting, step by step:
//   1. startConnect: make a random "state" + a PKCE secret, save them (hashed state) for 10 min,
//      and send the browser to Google/Microsoft with them.
//   2. The person signs in there and agrees.
//   3. handleCallback: Google/Microsoft send the browser back with ?code&state. We take the
//      slip (once only, not expired), swap the code (+ PKCE secret) for tokens, encrypt the
//      refresh token and save the mailbox. Then send the browser to /mail.
// Nobody's password ever passes through Workard.
// ============================================================

const STATE_MINUTES = 10;
const PUBLIC_FIELDS = (a) =>
  a && {
    provider: a.provider,
    email: a.email,
    displayName: a.display_name,
    status: a.status,
    lastError: a.last_error,
    connectedAt: a.connected_at,
    signatureHtml: a.signature_html || '',
    isWorkspace: Boolean(a.is_workspace),
    canRead: Boolean(a.can_read),
  };

// ---------- Is the inbox allowed for this mailbox? ----------
// Microsoft: yes once read access was granted. Google: depends on MAIL_GOOGLE_INBOX (see env.js).
export function inboxAllowed(account) {
  if (!account || !account.can_read) return false;
  if (account.provider === 'microsoft') return true;
  const mode = env.mail.googleInbox;
  return mode === 'all' || (mode === 'workspace' && Boolean(account.is_workspace));
}

// Should "Turn on inbox" be offered? (Google only: they connected with send-only first)
function inboxCanBeTurnedOn(account) {
  if (!account || account.provider !== 'google' || account.can_read) return false;
  const mode = env.mail.googleInbox;
  return mode === 'all' || (mode === 'workspace' && Boolean(account.is_workspace));
}

// What the Mail page and Settings → My email need
export async function getStatus(auth) {
  const account = await mailAccountModel.findForUser(auth.orgId, auth.userId);
  return {
    providers: Object.fromEntries(PROVIDER_NAMES.map((p) => [p, getProvider(p).isConfigured()])),
    googleInbox: env.mail.googleInbox,
    account: PUBLIC_FIELDS(account),
    inbox: {
      allowed: inboxAllowed(account),
      canTurnOn: inboxCanBeTurnedOn(account),
      // Personal Gmail while reading is limited, or Workspace before its admin trusts Workard
      reason: !account
        ? null
        : inboxAllowed(account)
          ? null
          : account.provider === 'google' && env.mail.googleInbox === 'off'
            ? 'Reading Gmail inside Workard is coming soon. You can already send from Gmail here.'
            : account.provider === 'google' && !account.is_workspace && env.mail.googleInbox === 'workspace'
              ? 'Reading personal Gmail inside Workard is coming soon. Google Workspace (company) accounts can turn the inbox on now.'
              : null,
    },
  };
}

// ---------- Connect ----------
const base64url = (buf) => buf.toString('base64url');

export async function startConnect(auth, providerName, { withInbox = false } = {}) {
  const provider = getProvider(providerName);
  if (!provider) throw new AppError(404, 'Unknown email provider');
  if (!provider.isConfigured()) {
    throw new AppError(503, `${providerName === 'google' ? 'Google' : 'Microsoft'} email isn't set up on this Workard server yet.`);
  }
  // Google's read permission only when the inbox may be used (it needs Google's assessment)
  const mode = env.mail.googleInbox;
  const readGoogle = mode === 'all' || (mode === 'workspace' && withInbox);

  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(48)); // PKCE: proves the same server finishes the sign-in
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  await mailAccountModel.createState({
    stateHash: hashToken(state),
    orgId: auth.orgId,
    userId: auth.userId,
    provider: providerName,
    codeVerifier,
    withInbox: providerName === 'microsoft' || readGoogle,
    expiresAt: new Date(Date.now() + STATE_MINUTES * 60_000),
  });
  mailAccountModel.cleanOldStates().catch(() => {});
  return { url: provider.authUrl({ state, codeChallenge, withInbox: readGoogle }) };
}

// Google/Microsoft send the browser here. Always ends with a redirect to the Mail page.
export async function handleCallback(providerName, { code, state, error }) {
  const back = (query) => `${env.clientUrls[0]}/mail?${new URLSearchParams(query)}`;
  const provider = getProvider(providerName);
  if (!provider || !state) return back({ mailError: 'The connection could not be completed. Please try again.' });

  const slip = await mailAccountModel.takeState(hashToken(String(state)), providerName);
  if (!slip) return back({ mailError: 'That connection link has expired. Please click Connect again.' });
  if (error || !code) return back({ mailError: error === 'access_denied' ? 'You cancelled the connection.' : 'The connection was not completed.' });

  try {
    const result = await provider.exchangeCode({ code: String(code), codeVerifier: slip.code_verifier });
    if (!result.email) throw new AppError(502, 'Could not read your email address from the provider.');
    await mailAccountModel.save(slip.organization_id, slip.user_id, {
      provider: providerName,
      email: result.email,
      displayName: result.name,
      refreshTokenEnc: encrypt(result.refreshToken),
      accessTokenEnc: encrypt(result.accessToken),
      accessExpiresAt: new Date(Date.now() + (Number(result.expiresIn || 3600) - 60) * 1000),
      scopes: result.scopes,
      isWorkspace: result.isWorkspace,
      canRead: result.canRead,
    });
    await auditModel.log({ orgId: slip.organization_id, userId: slip.user_id, action: 'mail.connected', details: `${providerName}: ${result.email}` });
    return back({ connected: providerName });
  } catch (err) {
    console.error('Mail connect failed:', err.message);
    return back({ mailError: err.message || 'The connection failed. Please try again.' });
  }
}

// ---------- Using the connection ----------
// The account WITH tokens, or a clear error if there is none / it needs reconnecting
export async function requireAccount(auth) {
  const account = await mailAccountModel.findWithTokens(auth.orgId, auth.userId);
  if (!account) throw new AppError(409, 'Connect your Gmail or Outlook first (Mail → Connect).');
  if (account.status === 'needs_reconnect') throw new AppError(409, 'Your email connection has expired. Please reconnect your mailbox.');
  return account;
}

// A working access token: the saved one if still fresh, otherwise a new one from the refresh token.
// If the provider says access was cancelled, the mailbox is marked "needs reconnect".
export async function getAccessToken(account) {
  const fresh = account.access_token_enc && account.access_expires_at && new Date(String(account.access_expires_at).replace(' ', 'T')) > new Date();
  if (fresh) return decrypt(account.access_token_enc);
  const provider = getProvider(account.provider);
  try {
    const result = await provider.refresh(decrypt(account.refresh_token_enc));
    await mailAccountModel.updateTokens(account.id, {
      accessTokenEnc: encrypt(result.accessToken),
      accessExpiresAt: new Date(Date.now() + (Number(result.expiresIn || 3600) - 60) * 1000),
      refreshTokenEnc: result.refreshToken ? encrypt(result.refreshToken) : null,
    });
    return result.accessToken;
  } catch (err) {
    if (err.needsReconnect) await mailAccountModel.markNeedsReconnect(account.id, err.message);
    throw new AppError(err.needsReconnect ? 409 : 502, err.message);
  }
}

// Runs a provider call with a fresh token; if the provider rejects the token, mark the mailbox
export async function withProvider(account, fn) {
  const token = await getAccessToken(account);
  try {
    return await fn(getProvider(account.provider), token);
  } catch (err) {
    if (err.needsReconnect) {
      await mailAccountModel.markNeedsReconnect(account.id, err.message);
      throw new AppError(409, err.message);
    }
    if (err.status && err.status < 500 && err instanceof AppError) throw err;
    throw new AppError(502, err.message || 'The email provider did not respond. Please try again.');
  }
}

// ---------- Signature & disconnect ----------
export async function setSignature(auth, { signatureHtml }) {
  const account = await mailAccountModel.findForUser(auth.orgId, auth.userId);
  if (!account) throw new AppError(409, 'Connect your mailbox first.');
  await mailAccountModel.setSignature(auth.orgId, auth.userId, cleanHtml(signatureHtml).slice(0, 5000));
  return getStatus(auth);
}

export async function disconnect(auth) {
  const account = await mailAccountModel.findWithTokens(auth.orgId, auth.userId);
  if (!account) return getStatus(auth);
  try {
    await getProvider(account.provider).revoke(decrypt(account.refresh_token_enc));
  } catch (err) {
    console.error('Mail revoke failed (removing anyway):', err.message); // the token is deleted either way
  }
  await mailAccountModel.remove(auth.orgId, auth.userId);
  await auditModel.log({ orgId: auth.orgId, userId: auth.userId, action: 'mail.disconnected', details: `${account.provider}: ${account.email}` });
  return getStatus(auth);
}
