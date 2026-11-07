import { env } from '../config/env.js';

// ============================================================
// Rebuild the website on Vercel (VERCEL_DEPLOY_HOOK_URL), so new blog posts and
// prices are prerendered into the public pages (good for Google and link previews).
// Several changes within a minute cause ONE rebuild. Never throws.
// ============================================================

const WAIT_MS = 60_000;
let timer = null;
let reasons = [];
export let lastTriggeredAt = null;

export function requestRebuild(reason) {
  if (!env.deployHookUrl) return false;
  reasons.push(reason);
  if (timer) return true;
  timer = setTimeout(async () => {
    const why = [...new Set(reasons)].join(', ');
    timer = null;
    reasons = [];
    try {
      const res = await fetch(env.deployHookUrl, { method: 'POST' });
      lastTriggeredAt = new Date();
      console.log(`🔁 Website rebuild requested (${why}): ${res.status}`);
    } catch (err) {
      console.error('Website rebuild failed:', err.message);
    }
  }, WAIT_MS);
  timer.unref?.();
  return true;
}

export const rebuildConfigured = () => Boolean(env.deployHookUrl);
