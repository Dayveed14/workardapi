import 'dotenv/config';

// Every date in the app ("today", late clock-ins) uses this timezone.
// Set before anything else reads the clock — import this module first.
process.env.TZ = process.env.APP_TIMEZONE || 'Africa/Lagos';

const isProd = process.env.NODE_ENV === 'production';

/* ---------- helpers ---------- */

const str = (name, fallback = '') => process.env[name]?.trim() || fallback;

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
};

const bool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['true', '1', 'yes'].includes(raw.toLowerCase());
};

const stripSlash = (url) => url.replace(/\/+$/, '');

const list = (name, fallback) =>
  str(name, fallback)
    .split(',')
    .map((u) => stripSlash(u.trim()))
    .filter(Boolean);

function required(name) {
  const value = str(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Required in production, optional (with fallback) in development.
const requiredInProd = (name, fallback = '') => (isProd ? required(name) : str(name, fallback));

function oneOf(name, allowed, fallback) {
  const value = str(name, fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`Env var ${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value;
}

/* ---------- config ---------- */

const port = num('PORT', 5000);

export const env = Object.freeze({
  isProd,
  port,
  timezone: process.env.TZ,

  clientUrls: list('CLIENT_URL', 'http://localhost:5173'),

  // How many proxies sit in front of the API, so it sees each visitor's real IP
  // (office Wi-Fi clock-in check, login rate limits):
  //   1 = browsers call Render directly, 2 = through the Vercel /api rewrite
  trustProxy: num('TRUST_PROXY', 1),

  db: Object.freeze({
    host: str('DB_HOST', 'localhost'),
    port: num('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '', // not trimmed — passwords may contain spaces
    database: str('DB_NAME', 'workard'),
    ssl: bool('DB_SSL'),
    sslCa: str('DB_SSL_CA') || undefined,
  }),

  jwt: Object.freeze({
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpires: str('JWT_ACCESS_EXPIRES', '15m'),
    refreshDays: num('JWT_REFRESH_DAYS', 7),
  }),

  cookieSameSite: oneOf('COOKIE_SAMESITE', ['lax', 'strict', 'none'], 'lax'),

  resend: Object.freeze({
    apiKey: str('RESEND_API_KEY'),
    from: str('EMAIL_FROM', 'Workard <noreply@fixer.com>'),
  }),

  // Phase 3 — payroll
  encryptionKey: requiredInProd('ENCRYPTION_KEY'),
  paystackBaseUrl: stripSlash(str('PAYSTACK_BASE_URL', 'https://api.paystack.co')),
  apiPublicUrl: stripSlash(str('API_PUBLIC_URL', `http://localhost:${port}`)),

  // Phase 3B — daily task jobs
  cronSecret: requiredInProd('CRON_SECRET'),

  // Plans & billing — WORKARD'S OWN Paystack secret key (organisations pay their yearly plan into it).
  // Not the same as the keys businesses add for payroll.
  // Plans & payment switch. false (default) = Workard is free for everyone (early access).
  // true = new organisations get a free trial, then pay. Organisations that signed up while
  // it was free get their trial from BILLING_START_DATE (YYYY-MM-DD, the day you switch on).
  billingEnabled: bool('BILLING_ENABLED', false),
  trialDays: num('TRIAL_DAYS', 14),
  billingStartDate: str('BILLING_START_DATE'),
  billingPaystackKey: str('PAYSTACK_SECRET_KEY'),

  // Video meetings (LiveKit Cloud or your own LiveKit server). Empty = meetings can be
  // scheduled, but "Join" says video isn't set up yet.
  livekit: {
    url: str('LIVEKIT_URL'), //          wss://your-project.livekit.cloud
    apiKey: str('LIVEKIT_API_KEY'),
    apiSecret: str('LIVEKIT_API_SECRET'),
  }, // empty → plan payments show "not set up yet" (the API still starts)

  // Workard super admin / blog: Vercel "deploy hook" URL. Publishing a blog post or changing
  // prices calls it, so the website is rebuilt with the new content (prerendered for SEO).
  // Empty = nothing is called (rebuild by redeploying on Vercel).
  deployHookUrl: str('VERCEL_DEPLOY_HOOK_URL'),

  // Email from your own Gmail / Outlook (Mail page). Each provider is optional:
  // without its keys, "Connect Google" / "Connect Microsoft" says it isn't set up yet.
  // Redirect URI to register with Google/Microsoft: <MAIL_CALLBACK_BASE>/api/mail/oauth/<google|microsoft>/callback
  mail: Object.freeze({
    callbackBase: stripSlash(str('MAIL_CALLBACK_BASE', str('API_PUBLIC_URL', `http://localhost:${port}`))),
    google: Object.freeze({ clientId: str('GOOGLE_CLIENT_ID'), clientSecret: str('GOOGLE_CLIENT_SECRET') }),
    microsoft: Object.freeze({ clientId: str('MICROSOFT_CLIENT_ID'), clientSecret: str('MICROSOFT_CLIENT_SECRET') }),
    // Reading Gmail needs Google's restricted-scope verification + yearly security assessment.
    //   off       — Gmail: send only (default)
    //   workspace — inbox for Google Workspace accounts (their admin trusts Workard); personal Gmail: send only
    //   all       — inbox for every Gmail account (after the assessment)
    googleInbox: oneOf('MAIL_GOOGLE_INBOX', ['off', 'workspace', 'all'], 'off'),
    // Tests point these at fake servers; leave empty in real use
    googleAuthBase: str('MAIL_GOOGLE_AUTH_BASE', 'https://accounts.google.com'),
    googleTokenBase: str('MAIL_GOOGLE_TOKEN_BASE', 'https://oauth2.googleapis.com'),
    googleApiBase: str('MAIL_GOOGLE_API_BASE', 'https://gmail.googleapis.com'),
    microsoftAuthBase: str('MAIL_MICROSOFT_AUTH_BASE', 'https://login.microsoftonline.com'),
    microsoftApiBase: str('MAIL_MICROSOFT_API_BASE', 'https://graph.microsoft.com'),
  }),

  cloudinary: Object.freeze({
    cloudName: str('CLOUDINARY_CLOUD_NAME'),
    apiKey: str('CLOUDINARY_API_KEY'),
    apiSecret: str('CLOUDINARY_API_SECRET'),
    folder: str('CLOUDINARY_FOLDER', 'workard'),
  }),
});

// SameSite=None cookies are rejected by browsers unless Secure is set (HTTPS).
if (env.cookieSameSite === 'none' && !isProd) {
  console.warn('[env] COOKIE_SAMESITE=none requires Secure cookies over HTTPS.');
}