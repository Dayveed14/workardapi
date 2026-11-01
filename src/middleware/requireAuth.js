import { ACCESS_COOKIE, verifyAccessToken } from '../utils/tokens.js';

// Reads the JWT from the httpOnly cookie (or a Bearer header for API clients/mobile)
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token =
    req.cookies?.[ACCESS_COOKIE] || (header?.startsWith('Bearer ') ? header.slice(7) : null);

  if (!token) return res.status(401).json({ message: 'Not authenticated' });

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: Number(payload.sub), businessId: payload.bid, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ message: 'Session expired', code: 'TOKEN_EXPIRED' });
  }
}

// Usage: router.get('/x', requireAuth, requireRole('owner','admin'), handler)
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ message: 'You do not have permission to do this' });
    }
    next();
  };
}
