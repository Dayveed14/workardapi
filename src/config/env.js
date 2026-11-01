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