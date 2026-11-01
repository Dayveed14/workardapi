// Returns the caller's public IP. Behind Render/Vercel the real IP comes from
// X-Forwarded-For, which Express reads because app.set('trust proxy', 1).
export function getClientIp(req) {
  let ip = req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4 written in IPv6 form
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

// "102.89.1.10, 41.58.2.3" → ['102.89.1.10', '41.58.2.3']
export function parseIpList(value) {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}
