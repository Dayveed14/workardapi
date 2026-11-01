import { env } from '../config/env.js';

export const ACCESS_COOKIE = 'wk_access';
export const REFRESH_COOKIE = 'wk_refresh';

function baseCookie() {
  return {
    httpOnly: true, // JavaScript in the browser cannot read it
    secure: env.isProd || env.cookieSameSite === 'none',
    sameSite: env.cookieSameSite,
  };
}

export function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), path: '/', maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    path: '/api/auth', // only sent to auth endpoints
    maxAge: env.jwt.refreshDays * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: '/api/auth' });
}
